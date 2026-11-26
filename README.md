# 🐝 pi-swarm (`v1.0.0`)

**`pi-swarm`** is a **Dynamic Mission Goal Engine & Antigravity Swarm** multi-agent orchestration extension for [Pi](https://github.com/earendil-works/pi) (`v1.5.2+`, verified on `v1.6.0`).
面向 [Pi](https://github.com/earendil-works/pi) (`v1.5.2+`，已验证 `v1.6.0`) 的**动态目标契约引擎与蜂群（Dynamic Mission Goal Engine & Antigravity Swarm）多 Agent 协作与编排扩展**。

Instead of locking work into a rigid upfront DAG or letting agents drift off objective, `pi-swarm` v1.0.0 unites **Antigravity-Swarm Shared-Workspace (`workspace: "inherit"`) Parallel Collaboration on Disjoint `filesOwned` Slices** (zero worktree sprawl & zero merge overhead by default, with opt-in `share` / `branch` Git worktrees when overlapping-file isolation is needed), **Closed-Loop Mission-Level TDD (Mandatory `VAL-*` Validation Contracts + Dynamic Feature Queues + Pre-Modal Adversarial Contract Review)**, **Deterministic `dispatch_ready` Queue Execution + Dual-Layer Independent Validation**, **Sisyphus Anti-Premature-Stop Auto-Continuation**, and **Droid Mission-style Model & Effort Configuration + Cross-Session Mission Resume** (`/swarm resume`) with unified floating Mission Hub (`/swarm`, `Alt+S`), live `swarm{action:"mission"}` mid-flight scope steering, `services.json` port manifest, shared `library/*.md` knowledge base with inline `[l]` reader, audited `[OVERRIDE]` gates, searchable provider-grouped Model Picker (`/swarm models`, `Alt+M`), expanded live dashboard (`Alt+W`), non-blocking `swarm_wait`, disk-persisted member sessions (`SessionManager.create`/`open`), hot & queued turn-end model switching, and Smart LLM Monitor (`@monitor`).

### 🆕 v1.0.0 — Antigravity Shared-Workspace Default, Floating Modals & Inline Library Reader / 共享工作区默认协作、全悬浮契约优先面板与知识库内联阅读器

- **`workspace: "inherit"` Shared-Workspace Default & Zero Worktree Sprawl / 默认共享工作区协作（零 Worktree 膨胀）**: Like Antigravity Swarm, parallel workers default to **`workspace: "inherit"`**, collaborating directly in the shared repository root on disjoint `filesOwned` slices with **zero worktree creation sprawl** and **zero `git merge` overhead**. Isolated Git worktrees (`workspace: "share"`) and standalone clones (`workspace: "branch"`) remain available as explicit opt-ins whenever two concurrent tasks must touch overlapping files or run conflicting build state.
- **Floating `{ overlay: true }` Questionnaires & Contract-First Proposal Modal / 全悬浮问答与契约优先确认浮层**: `swarm_question`, `swarm_questionnaire`, and `propose_swarm_plan` render as centered floating `{ overlay: true }` modals. `propose_swarm_plan` renders a sticky `Features · VAL · Milestones` header plus **Validation Contract (`VAL-*` + `evidenceRequired`)** and **Feature Queue (`filesOwned`, `fulfills`, `dependsOn`)** first at `scrollOffset = 0`, so contract coverage is immediately visible even on `72x20` and `80x24` terminals.
- **Inline Shared `library/*.md` Reader (`[l]`) & Contract Discoverability / 共享知识库内联阅读与契约透视**: Mission Control Tab `[3]` dynamically reflects `[3] Contract` / `[3] Graph/Contract`, surfaces `[3→v] Contract` cues in the pipeline strip and Mission Hub, loads real `.pi/swarm/runs/<run-id>/library/*.md` topics via `read_library`, and binds **`l`** in Contract view to cycle and read `library/*.md` markdown inline (`Esc` returns to the Contract overview).
- **80-Column Responsive Dashboard & Safe Keybindings / 80 列响应式仪表盘与安全快捷键**: `Alt+W` expanded dashboard surfaces `[OVERRIDE]` + `overrideJustification` and failed/blocked `VAL-*` assertions alongside active features, preserves `Activity` over `Turns` at `80` columns, keeps `🐝 [completed] <Mission Title>` readable at `80` columns, restricts worktree merge to lowercase **`g`** (never `Shift+G`) and kill to **`K` (`Shift+K`)**, and supports `Alt+1..4` role-tab jumps in `SwarmModelPickerView` even while filtering.

### 🆕 v0.9.0 — Closed-Loop Contract Discipline, Deterministic Queue & Dual-Layer Validation / 闭环契约铁律、确定性队列调度与双层独立验证

- **Mandatory `VAL-*` + `features` Schema & Pre-Modal Adversarial Contract Reviewer / 强制契约 Schema 与确认前对抗式契约审查**: `ProposeSwarmPlanParamsSchema` enforces required `assertions` and `features` (`minItems: 1`) at Pi tool-schema level so no LLM can omit the contract. Before opening the user confirmation modal, an ephemeral `validatorModel` **Adversarial Contract Reviewer** audits the draft for untestable assertions, missing failure-path coverage, port collisions, and invalid commands—bouncing blocking gaps once automatically (`status: "contract_review_changes_requested"`) before bothering the user.
- **Zero LLM `force: true` Bypass & Audited `[OVERRIDE]` (`override_assertion`) / 封禁 LLM 强行跳过与可审计豁免机制**: LLM calls to `swarm{action:"done", force:true}` and `swarm{action:"mission", mission_op:"verify_assertion", force:true}` are strictly rejected (`PERMISSION_DENIED`); only human `/swarm done --force` CLI invocations (`callerRole: "human"`) may force-close a run. Genuinely blocked assertions require `swarm{action:"mission", mission_op:"override_assertion"}` with a substantive `>=30`-char `override_justification`, recorded permanently with `[OVERRIDE]` badges across `/swarm status`, `Alt+W`, Mission Control `[v]`, `validation-contract.md`, and the Rich Mission Complete Card.
- **Deterministic `dispatch_ready` Queue Runner, Disjoint `filesOwned` Shared-Workspace Default & `"init"` Hook / 确定性就绪队列派发与共享工作区切片协作**: `swarm{action:"mission", mission_op:"dispatch_ready"}` deterministically selects non-conflicting `"pending"` features whose `depends_on` are `"completed"`, marks them `"in_progress"`, spawns `workspace:"inherit"` workers by default on disjoint `filesOwned` slices (or opt-in `workspace:"share"` worktrees with auto-symlinked `node_modules`/`.venv` when overlapping-file isolation is requested), and runs the Mission `"init"` command before worker turns begin.
- **Auto-Spawned Dual-Layer (`scrutiny` + `behavioral`) Validator & Incremental Re-Testing / 自动双层独立验证官与增量复测**: Merging the final feature of a milestone automatically spawns or wakes `@validator` (`role:"validator"`) with a 2-layer review brief (**Layer 1 Code Scrutiny** + **Layer 2 Behavioral `VAL-*` Execution**) and incremental re-test scoping (`completedAt` vs `verifiedAt` so fix cycles re-verify affected assertions plus regression smoke checks).
- **Mandatory Worker `[done]` `verification_evidence` Handoff / Worker 完成强制验证证据交接**: Workers completing feature work with `[done]` on `post_message` must include substantive `handoff.salient_summary` and `handoff.verification_evidence` (`commands_run` or `interactive_checks`), preventing unverified `"trust me, done"` handoffs at runtime.
- **`services.json` Port Manifest & Shared `.pi/swarm/runs/<run-id>/library/*.md` / 服务端口清单与共享架构知识库**: Declare multi-process `services` (`name`, `start`, `stop`, `healthcheck`, unique `port`, acyclic `depends_on`) persisted to `services.json` and surfaced in **Mission Services & Ports** UI tables; share cross-worker architecture notes and environment quirks via `swarm{action:"mission", mission_op:"write_library"|"read_library"}` stored in `.pi/swarm/runs/<run-id>/library/*.md`.

### v0.8.0 — Dynamic Mission Goal Engine / 动态目标契约引擎

- **Mission-Level TDD & `VAL-*` Validation Contract / 任务级 TDD 与验证契约 (`validation-contract.md` · `validation-state.json`)**: `propose_swarm_plan` defines testable `VAL-<AREA>-<NNN>` behavioral assertions with required evidence alongside ordered vertical `features` (`features.json`), `commands`, and `boundaries` (`mission.md`). Pre-modal gates enforce 100% `fulfills` assertion coverage, 1-to-1 leaf ownership, and 3-color DFS cycle detection across `depends_on`.
- **Living Dynamic Mid-Run Scope (`swarm{action:"mission"}`) & Smart `/swarm tweak` / 运行中动态演进**: Mutate features, assertions, commands/boundaries, milestones, and handoff items mid-flight via `swarm{action:"mission"}` (`status`, `set_manifest`, `upsert_assertions`, `upsert_features`, `update_feature`, `verify_assertion`, `seal_milestone`, `resolve_handoff`). `/swarm tweak` smartly preserves `"passed"` assertions + evidence and `"completed"` features + `mergedCommitSha` while resetting modified assertions to `"pending"`.
- **Independent Verification, Auto-Injected Milestone Review & Sealed Milestones / 独立验证、自动里程碑审查与封印防篡改**: Workers and `@monitor` cannot mark `VAL-*` assertions `"passed"` (`PERMISSION_DENIED`); when `validatorEnabled: true`, only `role:"validator"` (or human / explicit `force: true`) can certify `"passed"` with concrete `evidence`. Merging the final feature of a milestone auto-posts `[milestone-review]` to wake the Orchestrator/Validator, and milestones auto-seal (`[S]`) once every feature is `"completed"` and every fulfilled `VAL-*` is `"passed"`, blocking scope creep or silent status regressions unless an assertion fails.
- **Structured Handoff Tech-Debt Gate & Hard Completion Gates / 结构化交接债闸门与完成硬门槛**: Workers attach structured `discovered_issues`, `incomplete_work`, `salient_summary`, `what_was_implemented`, `verification_run`, and `critical_context` directly on `post_message`, creating open `MissionHandoffItem` entries on the run. `swarm{action:"done"}` enforces 5 hard gates: zero working members, zero unmerged isolated commits, 100% non-cancelled features `"completed"`, 100% `VAL-*` assertions `"passed"` & claimed, and zero unresolved handoffs (`resolve_handoff` requires either a `tracked_feature_id` or a substantive `>=20`-char `dismissed` justification).
- **Sisyphus `agent_settled` Auto-Continuation & `[NEEDS_HUMAN]` Escape Hatch / 西西弗斯防早停自动续跑**: If the Orchestrator ends a turn with plain text while structured Goal items remain unfinished (and no member is working and `swarm_wait` is not armed), `pi-swarm` injects a `🎯 Pi Swarm Goal Checkpoint` follow-up turn automatically—complete with a `[NEEDS_HUMAN]` escape hatch and a 2-stagnant-turn / 12-continuation no-progress circuit breaker (reset on user input, `/swarm resume`, or `/swarm tweak`).
- **Live Goal UI, Contract Inspector & Droid Proposal Card / 实时目标进度面板与契约检查器**: Above-editor dashboard (`Alt+W`), `/swarm status` (`/swarm contract` · `/swarm mission` · `/swarm goal`), Mission Control pipeline strip, `/swarm tasks contract` (`[v]` toggle on Graph tab), scrollable `propose_swarm_plan` modal (`[`/`]`/`PgUp`/`PgDn`), and the Rich Mission Complete Card surface live `Features X/Y`, `VAL A/B`, `[S]` sealed milestones, and `!N debt` cleanly at both `100x30` and `72x20`.

### v0.7.0 — Pi 1.6.0 Polish, Floating Overlays & Live Telemetry / Pi 1.6.0 适配、悬浮面板与实时遥测

- **Native Pi 1.6.0 UX & Markdown Rendering / 原生 Markdown 渲染与命令补全**: `/swarm status`, `/swarm board`, `/swarm help`, and `/swarm models --print` render via native Pi `Markdown` + `Box` with `keyHint` styling; exact subcommand completions submit on a single `Enter` (no double-Enter trap); `setWorkingMessage`/`setTitle` track active swarm progress and pre-swarm host models are automatically restored on `done`/`cancel`.
- **Floating Hub & Model Picker Overlays / 悬浮 Hub 与模型选择器**: `/swarm` (Hub) and `/swarm models` open as centered floating overlays with terminal-aware height capping, 1-cell safe box glyphs, `* Current / Host` model pinning, and `Esc`-clears-search behavior.
- **Live Streaming Telemetry & Mission Control Overhaul / 实时流式遥测与任务控制升级**: Real-time token/cost/tool streaming with monotonic flush on stop/pause/complete, `phase` & `milestones` progress tracking (`swarm{action:"title"}`), adaptive `Alt+W` expanded dashboard height clamping, 1-line collapsed completed runs, live 120ms overlay spinner, `j`/`k` navigation across all 4 tabs (`Shift+K` for Kill), and `[r]` direct Retry/conflict-steer action.
- **Worktree Safety & Recovery / 工作树保护与自愈**: `teardown` protects active members and unmerged branches with commits ahead unless `force: true`; missing isolated worktrees auto-recover on revive; `DIRTY_BASE` and `missing_worktree` diagnostics guide clean recovery.
- **Collapsible Plan Preview & On-Demand Validator Guidance / 折叠计划预览与按需验证引导**: `propose_swarm_plan` collapses cleanly with `Ctrl+O` expand hint; drafting guidance avoids eager wave-1 validator spawns and respects pre-installed scripts.

### v0.6.0 — Usability & Orchestration Quality / 易用性与编排质量

- **SSH-friendly shortcuts / SSH 友好快捷键**: `Alt+S` (Mission Control overlay, or Swarm Hub when idle), `Alt+M` (Model Picker), `Alt+W` (toggle expanded dashboard) work over SSH/tmux where `Ctrl+Shift+*` chords are often swallowed.
- **New subcommand & aliases / 新命令与别名**: `/swarm stop <member>` interrupts a single member's current turn; `mc` (→ `tasks`, Mission Control), `ls`/`list` (→ `runs`), and `config` (→ `settings`) aliases.
- **Compact tool & wakeup cards / 紧凑工具卡片**: swarm tool calls and `swarm_wait` wakeups render as compact cards; press `Ctrl+O` to expand full details.
- **Orchestrator write/edit guard / 编排者写入保护**: the Orchestrator's `write`/`edit` tools are blocked during drafting and while a run is active, so code changes go through workers.
- **Validator worktree awareness / 验证者感知工作树**: validators now see peer worktree/clone paths so they review the actual branch under test.
- **Done & merge gates / 完成与合并闸门**: `swarm{action:"done"}` refuses while members are still working (pass `force:true` to override) and warns about unmerged worker branches.
- **Silent worker turns surfaced / 静默回合可见**: worker turns that end without posting are reported in `all_idle` wakeups instead of being lost.

---

## 工作原理 / How It Works

```text
  /swarm <goal>  (Main Pi Session · orchestratorModel)
        │
        ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ Phase 0 — Upfront Q&A & Flexible Plan Confirmation (3 Drafting Tools)     │
│  • Read-only repo reconnaissance (read / grep / find / ls)                │
│  • swarm_question / swarm_questionnaire  (事前澄清, pi-goal-x style)      │
│  • propose_swarm_plan (title, objective, phased strategy, acceptance      │
│    criteria, optional initial_members) → scrollable modal confirm         │
└───────────────────────────────────────┬───────────────────────────────────┘
                                        │ Confirm (or /swarm direct autoConfirm)
                                        ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ Dynamic Antigravity Swarm Orchestration (4 Core Swarm Tools)              │
│  Tools: swarm · post_message · read_board · swarm_wait                    │
│                                                                           │
│  1. Researchers / Scouts   workspace:"inherit"  → post findings (#seq)    │
│  2. Contract / Scaffold    workspace:"inherit"  → post API (#N)           │
│  3. Parallel Workers       workspace:"inherit" default on disjoint        │
│                            filesOwned slices (zero worktree/merge cost;   │
│                            opt-in "share"/"branch" for overlapping files) │
│                            + optional fork:"orchestrator|<member>"        │
│                            + scoped #channels (@#backend, @#ui)           │
│  4. Independent Validator  role:"validator" (read-only + guarded bash)    │
│                            audits diffs & tests, never self-certifies     │
│  5. Peer-to-Peer Warm Loop @validator ↔ @author direct fixes on the board │
│                            waking the SAME warm waiting handle (0 cold    │
│                            starts; SWARM_MAX_BOARD_HOPS = 24 cap)         │
│  6. Retire & Standby       (optional swarm{action:"merge"} if "share")    │
│                            → swarm{action:"done", summary}                │
│                            (retires specialists; @orchestrator stays on   │
│                             standby until user runs /swarm exit)          │
└───────────────────────────────────────────────────────────────────────────┘
```

### Persistent Swarm Orchestrator Mode & `/swarm exit` / 常驻编排官模式与显式退出

- **Entering Persistent Orchestrator Mode / 如何进入**: Confirming and launching a run (`/swarm <goal>`, `/swarm direct <goal>`, `/swarm-direct <goal>`) or resuming a run (`/swarm resume`) as the owning session activates sticky session-level **Persistent Swarm Orchestrator Mode** (persisted in the session focus entry across `/reload`, `/tree`, and compaction). Entering via `/swarm direct` or `/swarm-direct` sets `autoConfirmDefault: true` so subsequent standby proposals also auto-confirm; entering via `/swarm <goal>` keeps `autoConfirmDefault: false`. Read-only observer sessions inspecting a run owned by another live session never enter the mode.
- **Ephemeral Specialists vs Sticky Standby `@orchestrator` / 专家即用即毁与常驻待命**: Completing a run (`swarm{action:"done"}` or `/swarm done`) retires all worker and validator sessions, cleans up validator scratch directories, removes clean idle isolated worktrees when `autoTeardownOnComplete` is enabled (or when confirmed at the interactive `/swarm done` prompt, or later via `/swarm teardown`), and emits the Mission Complete card, while `@orchestrator` remains on duty in `"standby"` mode—retaining `orchestratorModel` + reasoning effort and the 5 `STANDBY_SWARM_TOOLS` (`swarm`, `read_board`, `swarm_question`, `swarm_questionnaire`, `propose_swarm_plan`).
- **What `@orchestrator` Will and Will Not Do in Standby / 待命职责与写入保护**:
  - **Will do**: Answer read-only codebase, architecture, test, and prior-run questions directly using `read`, `grep`, `find`, `ls`, read-only `bash` (`git status`, `git diff`, `rg`, `npm test`, etc.), `swarm{action:"status"}`, and `read_board` without starting a new run.
  - **Will NOT do**: Edit files or mutate repository state directly. Across **all** Orchestrator Mode states (`drafting`, `active`, `paused`, and `standby`), `write`, `edit`, and `powershell` are blocked directly by exact tool-name check, while common mutating `bash` commands (`git add`, `git commit`, `git merge`, `git push`, `rm`, `mv`, `cp`, `sed -i`, file redirects, package installs) are rejected by **best-effort pattern matching** (`isReadOnlyValidationCommand`). This best-effort pattern-matching `bash` rule exists to stop `@orchestrator` from editing by habit—not to confine it or act as a complete sandbox. `@orchestrator` never exits the mode on its own.
- **Follow-Up Coding Tasks in Plain Chat / 后续任务无缝流转**: Send follow-up feature requests, bug fixes, or refactors in plain chat without typing `/swarm` again. `@orchestrator` automatically runs read-only recon (carrying forward prior `.pi/swarm/runs/<run-id>/library/` notes), asks 0 or 1–3 high-leverage questions via `swarm_questionnaire` (skipped when `autoConfirmDefault: true`), and calls `propose_swarm_plan` to launch the next Swarm run. Cancelling a proposal or draft in standby returns to `"standby"` rather than dropping out of Orchestrator Mode.
- **Exiting Orchestrator Mode (`/swarm exit`) / 如何退出**: Only explicit user actions exit the mode: `/swarm exit` (alias `/swarm leave`), **Swarm Hub → `✗ Exit Swarm Orchestrator Mode (/swarm exit)`**, `/swarm focus none`, or `/swarm cancel` when abandoning a live run. `/swarm exit` refuses while a live (`active`/`paused`) run is attached unless `--force` is supplied (`/swarm exit --force` pauses and releases ownership of the run with all worktrees and branches intact so it stays resumable via `/swarm resume`). Exiting restores `idle` tools (`swarm` only), restores the in-memory pre-swarm host model & thinking level, re-enables direct editing, and persists `orchestratorMode: false` so `/reload` stays exited.
- **Manual `git commit` / `git push` (`!<command>`) / 手动提交与推送**: Neither workers nor `@orchestrator` are allowed to run `git push` (and `@orchestrator` cannot run manual `git commit` or `git merge` via `bash`). To push or commit by hand while staying in Orchestrator Mode, prefix the shell command with `!` in the Pi prompt (e.g. `!git push`, `!git status`, `!git commit -m "..."` — user `!` commands execute through Pi's `user_bash` pipeline and never hit the model `tool_call` guard), or run `/swarm exit` first.

### 核心特性 / Key Capabilities

- **4 Core Antigravity Swarm Tools (`swarm`, `post_message`, `read_board`, `swarm_wait`)**：编排器（Orchestrator）调用 `swarm_wait` 后会像 Antigravity一样**立即结束当前 turn 并异步休眠**，随时接受用户在运行中途发送自然语言调整方向（通过 `swarm{action:"steer"|"stop"|"title"}` 或 `/swarm steer` 实时重定向子 Agent）。
- **Warm & Disk-Persisted Sessions（温热 + 磁盘持久化会话）**：成员会话落盘至 `.pi/swarm/runs/<run-id>/sessions/`，同进程 `waiting` 保持零 Token 热上下文，即使彻底退出并重启 Pi，下次 `@mention` 仍能从磁盘 JSONL 无损恢复完整对话（自动清理崩溃悬挂 `toolCall`）。
- **Hot Model Switch Auto-Resume & Self-Switch（切模型自动恢复 + 自切延后）**：手动 `swarm{action:"model"}` 切换完立即自动唤醒继续未竟工作；Worker 对自己调用 `swarm{action:"model"}` 会安全排期在当前 turn 结束时切换并立即在新模型上续跑。
- **True Conversation `fork`（真实对话分叉）**：`swarm{action:"add", fork:"<member>|orchestrator"}` 真实继承父成员或主控会话的干净对话历史。
- **Smart LLM Monitor (`stallMonitorMode: "llm"`)**：全部成员空闲超 `stallTimeoutMs` 时，召唤只读诊断官 `@monitor` 分析板子并精准 `@具体卡点成员`（无问题则 `[noop]`，失败自动退化为确定性 `@orchestrator [stall]`）。
- **Independent Read-Only Validator（独立只读验证官）**：`role:"validator"` 强制隔离写工具（仅开放 `read`/`grep`/`find`/`ls` 与只读 `bash` 护栏），杜绝作者自审自过。
- **Shared-Workspace Default (`workspace:"inherit"`) + Opt-In Worktrees (`share` / `branch`)**：默认在主工作区对互不重叠的 `filesOwned` 切片直接并发协作（零工作树膨胀、零合并摩擦）；当多个任务必须修改同一批文件时，可按需显式开启 `workspace:"share"`（共享 `.git` 对象库的工作树）或 `workspace:"branch"`（独立 `git clone --no-hardlinks`），支持自动 `autoRebase` 与 `merge`。

---

## 快速开始 / Quick Start

Pi loads TypeScript extensions directly via `jiti` (no build step required):

```bash
# Try immediately in any project / 临时加载试用
pi -e /Users/bytedance/Code/pi-swarm

# Or install locally / 或本地安装
pi install /Users/bytedance/Code/pi-swarm
```

Start an interactive clarification + dynamic swarm session:

```text
/swarm Refactor the authentication middleware and add full integration tests
```

Or skip interactive Q&A via the fast-path command:

```text
/swarm direct Add date parsing & formatting utilities under src/date/ with unit tests
```

---

## 3 角色模型配置 / 3-Role Model Configuration

`pi-swarm` routes models across **3 orthogonal roles** (`orchestrator`, `worker`, `validator`), falling back to the host Pi session model whenever unset:

| Role (`角色`) | Responsibility (`职责`) | How It Applies (`生效方式`) |
| --- | --- | --- |
| **`orchestrator`** | Upfront Q&A, dynamic phasing, board coordination, worktree merges, completion | Applied directly to host Pi session via `pi.setModel()` / `pi.setThinkingLevel()` |
| **`worker`** | Researchers, scaffolders, parallel authors, helpers (`role:"worker"`) | Default for spawned workers; overridable per `add` or hot-switched while `waiting` / `stopped` |
| **`validator`** | Independent read-only code & test auditors (`role:"validator"`) | Default for spawned validators; overridable per `add` or hot-switched while `waiting` / `stopped` |

### 1) Layered Config Files / 分层配置文件

Merged in order: **`DEFAULT_SWARM_SETTINGS` ← Global (`~/.pi/agent/pi-swarm-settings.json`) ← Project (`<cwd>/.pi/pi-swarm-settings.json`)**. Legacy `v1` config keys are ignored cleanly.

```json
{
  "orchestratorModel": "anthropic/claude-opus-4-6",
  "orchestratorThinkingLevel": "high",
  "workerModel": "anthropic/claude-sonnet-4-5",
  "workerThinkingLevel": "medium",
  "validatorModel": "openai/gpt-5.2",
  "validatorThinkingLevel": "high",
  "fallbackModels": [
    "google/gemini-2.5-pro",
    "anthropic/claude-sonnet-4"
  ],
  "maxConcurrency": 6,
  "validatorEnabled": true,
  "keepWorkersWarm": true,
  "stallWatchdogEnabled": true,
  "stallMonitorMode": "llm",
  "stallTimeoutMs": 45000,
  "maxRetries": 2,
  "autoRebase": true,
  "autoTeardownOnComplete": false
}
```

### 2) Droid Mission-Style Model Picker & Live Control (`/swarm models`, `/swarm model`)

- **Interactive Model & Reasoning Effort Picker (`/swarm models` or `Alt+M`)**:
  - **4 Tabs (`Tab` / `Shift+Tab` / `Alt+1..4`)**: **`[Orchestrator]`** · **`[Worker]`** · **`[Validator]`** · **`[Fallbacks]`** (`Alt+1..4` jumps tabs directly even when a filter query is typed)
  - **2-Step Selection**: Search provider-grouped models → press `Enter` → select Reasoning Effort (`Default` | `Off` | `Minimal` | `Low` | `Medium` | `High ★` | `Extra high (xhigh)` | `Max`).
  - **Quick Shortcuts**: `Ctrl+S` toggles Save Scope (`Global ~/.pi/agent` vs `Project .pi/`, automatically unmasking stale project overrides when saving to Global) · `Ctrl+E` cycles effort inline · `Ctrl+X` resets role to `Inherit Host Session Model` · `Space` / `[` / `]` toggles and reorders `fallbackModels` · `Alt+M` / `Ctrl+M` opens inline Model Picker inside Mission Hub (`Enter` launches **Clarify & Plan** interactive drafting; `Alt+Enter` launches **Direct Swarm** fast-path).
- **Live Propagation (`Running agents switch at their next turn; Inherit applies only to new agents`)**:
  - Changing `worker` or `validator` updates `run.roleModels`, silently updates parked `waiting` / `stopped` members tracking the role default, and queues a turn-end switch for `working` members without disturbing explicit per-member overrides.

```text
# Open Interactive Mission Model Picker (or jump directly to a role tab / @member)
/swarm models
/swarm models validator

# Print zero-turn Markdown overview instead of opening the TUI picker
/swarm models --print

# One-line CLI with Pi/Droid `:thinking` shorthand (global or project scope)
/swarm model validator magpie/bp/gpt-6.2-astra:high --global
/swarm models worker magpie/auto/gemini-4-neon:high
/swarm model orchestrator anthropic/claude-opus-4-6 high

# Clear a role override back to host default (writes null in project layer to clear global override)
/swarm model worker default

# Hot-switch a specific live member (`@name` disambiguates members named `validator` / `worker`)
/swarm model @validator magpie/bp/gpt-6.2-astra:high
/swarm model author google/gemini-2.5-pro:high
```

On provider HTTP 429 / quota exhaustion, `SwarmEngine` also automatically tries the next untried model in `fallbackModels` (including `:thinking` specs on both warm `waiting` and cold `stopped` members when `keepWorkersWarm: false`) before falling back to shared exponential backoff (`RateLimitBreaker`).

---

## Channels, `#seq`, `@mention`, `fork` & Worktrees Guide

### Zero-Copy `#seq` Referencing / 零复制序号引用
Every message on `board.jsonl` receives a monotonic `#seq` (`#1`, `#2`, …). Cite prior findings by sequence number (`read_board{seqs:[4,6]}`) rather than copy-pasting verbose reports into downstream briefs.

### `@mention` Wakeup Doorbells / 精准唤醒门铃
- **`@<name>`**: Wakes one specific member (e.g., `@author`, `@validator`, `@orchestrator`).
- **`@<prefix>`**: Wakes every member in a sharded group spawned with `n: 3` or `tasks: [...]` (e.g., `@worker` wakes `worker-1`, `worker-2`, `worker-3`).
- **`@#<channel>`**: Broadcasts to all subscribers of a custom channel (e.g., `@#backend`). **`@#main` is intentionally rejected** — use `@all` for swarm-wide notices.
- **`@all`**: Swarm-wide rules, interface contracts, or plan changes (wakes everyone; use sparingly).
- **Completion convention**: Start completion posts with `[done]` after the mention (e.g., `@orchestrator [done] API landed in #8`).
- **Simultaneous post coalescing & hop cap**: Concurrent mentions arriving while a member is working/waking coalesce without drops; peer-to-peer bounce chains are bounded by `SWARM_MAX_BOARD_HOPS = 24`.

### Channels / 频道管理
Use `swarm{action:"channel", op:"create|list|join|leave|archive", channel, topic?, name?}` to isolate high-volume subsystems (`#backend`, `#frontend`, `#tests`) while keeping `#main` for cross-cutting coordination. Archived channels reject new posts and mentions.

### Context Forking (`fork`) / 对话分叉
- `swarm{action:"add", name:"validator", role:"validator", fork:"author", brief:"..."}`: Branches a warm member's conversation history into a new member.
- `swarm{action:"add", name:"architect", fork:"orchestrator", brief:"..."}`: Branches the host Orchestrator's Pi session history into a new member.

### Workspace Modes (`inherit` default vs opt-in `share` / `branch`)
- **`inherit` (default — Antigravity Swarm style)**: Workers, researchers/scouts, and validators collaborate directly in the shared repository root on disjoint `filesOwned` slices — delivering **zero worktree sprawl**, instant shared build/typecheck state, and **zero `git merge` overhead**.
- **`share` (explicit opt-in)**: Provisions an isolated linked Git worktree at `.pi/swarm/worktrees/<run-id>/wt-<member>/` on branch `swarm/<run-short>/<member>` sharing `.git` objects (auto-symlinking `node_modules`/`.venv`) — opt into this only when concurrent workers must edit overlapping files or isolate conflicting build artifacts.
- **`branch` (explicit opt-in)**: Provisions a **fully isolated standalone `git clone --no-hardlinks`** at `.pi/swarm/worktrees/<run-id>/wt-<member>/` on branch `swarm/<run-short>/<member>`, fetched back automatically on `swarm{action:"merge"}`.

---

## 命令参考 / Command Reference (`/swarm`)

Only **`/swarm`** and **`/swarm-direct`** are registered on Pi.

| Command (`命令`) | Description (`说明`) | LLM Turn? |
| --- | --- | :---: |
| `/swarm <goal>` | Interactive `pi-goal-x` drafting (`orchestratorModel` → Q&A → plan confirm → Dynamic Swarm) | Yes |
| `/swarm` (bare) | Open **Swarm Mission Hub** (`Alt+S` when idle: `🔄 Resume Mission`, Goal composer with `Enter` Clarify & Plan vs `Alt+Enter` Direct Swarm, `Alt+M` inline Models picker, Goal `Feat`/`VAL` status & quick actions) | No (until launched) |
| `/swarm direct <goal>` <br> `/swarm-direct <goal>` | Fast-path: skip Q&A (`autoConfirm: true`), propose plan and launch Dynamic Swarm immediately | Yes |
| `/swarm tweak [guidance]` | Revise the focused active/paused Mission plan, `VAL-*` contract, features, or spawn additional members (preserves passed `VAL-*` & completed features) | Yes |
| `/swarm status` <br> `/swarm contract` · `/swarm mission` · `/swarm goal` | Zero-turn dashboard: Mission Features, `VAL-*` Validation Contract, open handoffs, commands/boundaries, 3-role models, roster & recent board | **No** |
| `/swarm board [limit] [--channel <ch>] [--search <q>]` | Zero-turn shared `#seq` Message Board feed with optional channel & substring filters | **No** |
| `/swarm graph` | Zero-turn ASCII/Unicode Spawn Tree & Peer `@mention` / `#channel` Interaction Graph | **No** |
| `/swarm tasks [tab\|contract\|member\|#ch]` <br> `/swarm ui [tab\|contract\|member\|#ch]` <br> `/swarm tasks contract` | Open the live 4-tab Mission Control Overlay (**Board** / **Members** / **Graph/Contract** / **Search**; `/swarm tasks contract` or `[v]` opens **Mission Contract & Features**, and `[l]` reads `library/*.md` inline) | **No** |
| `/swarm models [role\|--print]` | Open interactive Mission Model Picker (`Orchestrator`/`Worker`/`Validator`/`Fallbacks`), or `--print` Markdown overview | **No** |
| `/swarm model <target> <model[:thinking]\|default> [thinking] [--global]` | Set role default (propagates to live role-tracking members) OR switch live `@member` (`waiting`, `stopped`, or queued turn-end on `working`) | **No** |
| `/swarm steer <member> <message>` | Steer a working member mid-turn or wake a parked member with new user direction | **No** |
| `/swarm stop <member> [reason]` | Interrupt a member's active turn cleanly and mark it `humanStopped` (revivable via `/swarm steer` or `[w]`/`[r]`) | **No** |
| `/swarm merge <member>` | Land an opt-in `share` worktree or `branch` clone onto `baseBranch` (`autoRebase` + `--no-ff`) | **No** |
| `/swarm kill <member> [--force] [reason]` | Permanently kill a member and remove its clean worktree (`--force` overrides dirty guard) | **No** |
| `/swarm done [--force] [summary]` | Complete the active run, retire ephemeral workers/validators & keep `@orchestrator` in `standby` (`--force` human-only override for unfinished Mission gates) | **No** |
| `/swarm exit [--force]` <br> `/swarm leave [--force]` | Exit Persistent Swarm Orchestrator Mode, restoring `idle` tools, pre-swarm host model & direct editing (`--force` pauses & detaches a live run cleanly so it stays resumable) | **No** |
| `/swarm pause [reason]` | Pause member launches and board wakeups | **No** |
| `/swarm resume [run-id] [--continue\|-c] [--quiet\|-q] [guidance]` | Zero-turn unpause (same focused session) OR Droid-style **Cross-Session Mission Resume** (auto-discovers active/paused runs, restores `orchestratorModel`, wakes Orchestrator cleanly) | No (same session / `--quiet`) · Yes (cross-session / guided) |
| `/swarm cancel` | Cancel active draft (restores underlying running/standby/idle state) or abandon focused live run (exits Orchestrator Mode, preserving worktrees & `.pi/swarm/runs/`) | **No** |
| `/swarm teardown [--force] [--delete-branches]` | Safely remove clean idle worktrees while preserving `.pi/swarm/runs/` audit & board logs | **No** |
| `/swarm runs` | List all runs in `.pi/swarm/runs/` with status, active/waiting counts & board head | **No** |
| `/swarm focus [run-id\|none]` | Switch session-local run focus without hijacking other Pi sessions (`none` detaches focus & exits Orchestrator Mode) | **No** |
| `/swarm settings` | View or edit 3-role models, `keepWorkersWarm`, `validatorEnabled`, watchdog, concurrency & git options | **No** |
| `/swarm help` | Print concise command reference | **No** |

---

## TUI 快捷键与悬浮面板 / TUI Shortcuts & Floating Overlays

### Global Editor Shortcuts & Above-Editor Live Dashboard
- **`Alt+S`**: Open **Mission Control** (`4-Tab` overlay when a run is focused) or **Swarm Mission Hub** (when idle).
- **`Alt+M`**: Open the interactive **Mission Model & Reasoning Effort Picker** (`Alt+1..4` or `Tab`/`Shift+Tab` switches role tabs even with a search filter).
- **`Alt+W`**: Toggle the above-editor dashboard between compact beacon (status badge, `O/W/V` model pills, `Feat`/`VAL` progress, working/waiting counts, latest board line) and **Expanded Live Dashboard** (Goal Progress with `[OVERRIDE]` & failed `VAL-*` visibility, Roster with live `Activity`, and recent `#seq` board feed).

### Swarm Mission Hub (`/swarm` or `Alt+S` when idle)
- **`Enter`**: Launch **Interactive Swarm (`Clarify & Plan`)** from the Goal input (or trigger the highlighted action when a run is active/paused).
- **`Alt+Enter`**: Launch **Direct Swarm** fast-path (`autoConfirm: true`, skips upfront Q&A; requires non-empty Goal).
- **`Alt+M`** / **`Ctrl+M`** (or **`m`** when active/paused): Open inline **Mission Models & Effort Picker**.
- **`Alt+V`** / **`Alt++`** / **`Alt+-`** (or **`v`** / **`+`** / **`-`** when active/paused): Toggle Independent Validator policy and adjust `maxConcurrency`.

### `/swarm tasks` (`/swarm ui` · `Alt+S`) 4-Tab Interactive Mission Control Overlay
- **`1` / `2` / `3` / `4`** or **`Tab` / `Shift+Tab`**: Switch tabs — **[1] Board** · **[2] Members** · **[3] Graph/Contract** · **[4] Search**
- **`M` (`Shift+M`)**: Open **Mission Models Picker** inline (`Orchestrator` / `Worker` / `Validator` / `Fallbacks`) · **`P` (`Shift+P`)**: Pause or Resume Swarm · **`?`**: Toggle Shortcuts Help
- **`j` / `k`** or **`↑` / `↓`**: Navigate Down / Up across **all 4 tabs** (including Members tab!) · **`[` / `]` / `PgUp` / `PgDn`**: Page-scroll post reader, member logs/diff, and Graph/Contract views
- **Board Tab `[1]`**: **`Enter`** open full scrollable `#seq` post reader (**`↑`/`↓`/`j`/`k`/`[`/`]`/`PgUp`/`PgDn`** scroll, **`Enter`/`Esc`** back) · **`p`** post a board message (`@mention` / `@#channel`) · **`c`** cycle channel filter (`*` / `#main` / custom channels)
- **Members Tab `[2]`**: **`w`** steer/wake selected member · **`r`** retry stopped/errored member (prefills rebase guidance on conflicts) · **`m`** switch Member Model & Effort (supports queued turn-end switch on `working` members, keeps 100% history) · **`x`** human-stop member · **`K` (`Shift+K`)** kill member (opens inline **`[y/Enter]`** confirm / **`[f]`** force dirty toggle / **`[n/Esc]`** cancel) · **`g`** (lowercase `g` only) merge opt-in `share`/`branch` worktree · **`Enter` / `l`** toggle full `brief` + `logTail` view · **`d`** toggle Git diff summary
- **Graph / Contract Tab `[3]`** (`/swarm tasks contract`): **`v`** toggles between Live Spawn Tree & Peer `@mention` Graph and the scrollable **Mission Contract & Features** inspector (`Milestones` with `[S]`, `Features`, `VAL-*` assertions + `[OVERRIDE]`, open handoffs, `Services & Ports`, `Commands & Boundaries`, and real `library/*.md` topics) · **`l`** (in Contract view) cycles/reads shared `.pi/swarm/runs/<run-id>/library/*.md` topics inline (**`Esc`** or cycling past the last topic returns to the full Contract overview)
- **Search Tab `[4]`**: Live IME substring search across every `#seq` message on the board (**`Enter`** opens full scrollable post reader after finishing query)
- **`Esc` / `q`**: Close overlay cleanly (or exit inline reader/prompt first; unsubscribes engine listener & restores terminal cursor)

### Plan Confirmation Modal (`propose_swarm_plan`)
- **`[` / `]` / `PgUp` / `PgDn`**: Scroll full Mission Contract (`VAL-*` assertions), Feature Queue (`fulfills` & `depends_on`), and Commands & Boundaries preview
- **`m`**: Open inline **Mission Model Picker** to adjust `O` / `W` / `V` / `Fallbacks` before launching
- **`c`**: Attach optional launch guidance / comment
- **`v`**: Toggle Independent Validator Policy (`ON` / `OFF`)
- **`+` / `-`**: Adjust `maxConcurrency`
- **`Enter`**: Confirm & Launch / Continue refining / Cancel
- **`Esc`**: Safely returns `Continue refining` without discarding the draft

---

## `.pi/swarm/` 持久化布局 / Persistence Layout

`.pi/swarm/` is automatically added to `.git/info/exclude` so `git status` stays clean.

```text
<projectRoot>/
├── .pi/
│   ├── pi-swarm-settings.json            # Optional project-level 3-role model & runtime overrides
│   └── swarm/
│       ├── .locks/                       # Per-run atomic lockfiles with stale-PID recovery
│       ├── runs/<run-id>/
│       │   ├── state.json                # Authoritative v2 run, members, features, assertions & handoffs snapshot
│       │   ├── mission.md                # Materialized Mission objective, boundaries & canonical commands
│       │   ├── validation-contract.md    # Materialized human-readable VAL-* behavioral contract & evidence status
│       │   ├── validation-state.json     # Machine-readable VAL-* verification state & milestone seal status
│       │   ├── features.json             # Machine-readable ordered Feature queue, DAG deps & fulfills claims
│       │   ├── services.json             # Machine-readable Mission Services & unique port manifest
│       │   ├── library/                  # Shared cross-worker Markdown knowledge base (architecture.md, etc.)
│       │   ├── ROSTER.md                 # Auto-rendered human-readable Markdown roster & channel table
│       │   ├── board.jsonl               # Append-only shared #seq Message Board (LF-only JSONL)
│       │   ├── events.jsonl              # Append-only audit event ledger
│       │   └── sessions/                 # Disk-persisted per-member SessionManager JSONL transcripts
│       └── worktrees/<run-id>/
│           └── wt-<member>/              # Isolated Git worktree for share/branch members
```

### 设置参数参考 / Settings Reference

| Setting | Default | Bounds / Notes |
| --- | :---: | --- |
| `orchestratorModel` / `orchestratorThinkingLevel` | `undefined` | Host Orchestrator model & thinking (`off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max`) |
| `workerModel` / `workerThinkingLevel` | `undefined` | Default model & thinking for `role:"worker"` members |
| `validatorModel` / `validatorThinkingLevel` | `undefined` | Default model & thinking for `role:"validator"` members |
| `fallbackModels` | `[]` | Ordered fallback models for automatic warm hot-switch on 429 / quota exhaustion |
| `maxConcurrency` | `6` | `1–64`, maximum concurrent working turns |
| `validatorEnabled` | `true` | Independent read-only Validator policy default |
| `keepWorkersWarm` | `true` | Keep completed members parked in zero-token warm `waiting` state with full history |
| `stallWatchdogEnabled` | `true` | Enable Stall Watchdog when all members idle silently |
| `stallMonitorMode` | `"llm"` | `"llm"` (read-only `@monitor` diagnoses & wakes single bottleneck member) \| `"deterministic"` (zero-token `@orchestrator` alert) |
| `stallTimeoutMs` | `45000` | `1000–3600000`, idle duration before Stall Watchdog triggers |
| `maxRetries` | `2` | `0–20`, transient failure retry budget |
| `rateLimitBaseBackoffMs` / `rateLimitMaxBackoffMs` | `5000` / `60000` | Shared exponential backoff bounds on HTTP 429 |
| `gitTimeoutMs` | `30000` | `1000–600000`, per-Git command timeout |
| `autoRebase` | `true` | Rebase `share`/`branch` worktree onto `baseBranch` before merging |
| `autoTeardownOnComplete` | `false` | Automatically remove clean idle worktrees when completing a run |

---

## 开发与测试 / Development & Testing

```bash
# Strict TypeScript typecheck / 严格类型检查
npm run typecheck

# Run full test suite (store/worktree/board, drafting, ui, engine, E2E integration)
npm test

# Run a single test file / 运行单个测试文件
npm run test:file -- tests/integration.test.ts
```

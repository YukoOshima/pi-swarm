# 🐝 pi-swarm (`v0.3.0`)

**`pi-swarm`** is a **Dynamic Antigravity Swarm** multi-agent orchestration extension for [Pi](https://github.com/earendil-works/pi) (`v1.5.2+`).
面向 [Pi](https://github.com/earendil-works/pi) (`v1.5.2+`) 的**动态蜂群（Dynamic Antigravity Swarm）多 Agent 协作与编排扩展**。

Instead of locking work into a rigid upfront DAG, `pi-swarm` v0.3.0 pairs **`pi-goal-x`-style upfront clarification** with **Antigravity-Swarm-grade dynamic orchestration**: non-blocking turn-ending `swarm_wait`, instant mid-flight user redirection (`swarm{action:"steer"|"stop"|"title"}`), disk-persisted member sessions (`SessionManager.create`/`open`), hot model switching with auto-resume (including self-switch deferral), Smart LLM Monitor (`@monitor`), true isolated `git clone` for `workspace:"branch"`, and 3-role model routing.

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
│  2. Contract / Scaffold    workspace:"inherit" or "share" → post API (#N) │
│  3. Parallel Workers       workspace:"share" (or n / tasks[] shards)      │
│                            + optional fork:"orchestrator|<member>"        │
│                            + scoped #channels (@#backend, @#ui)           │
│  4. Independent Validator  role:"validator" (read-only + guarded bash)    │
│                            audits diffs & tests, never self-certifies     │
│  5. Peer-to-Peer Warm Loop @validator ↔ @author direct fixes on the board │
│                            waking the SAME warm waiting handle (0 cold    │
│                            starts; SWARM_MAX_BOARD_HOPS = 24 cap)         │
│  6. Land, Retire & Close   swarm{action:"merge"} → swarm{action:"kill"}   │
│                            → swarm{action:"done", summary} (idle tools)   │
└───────────────────────────────────────────────────────────────────────────┘
```

### 核心特性 / Key Capabilities

- **4 Core Antigravity Swarm Tools (`swarm`, `post_message`, `read_board`, `swarm_wait`)**：编排器（Orchestrator）调用 `swarm_wait` 后会像 Antigravity一样**立即结束当前 turn 并异步休眠**，随时接受用户在运行中途发送自然语言调整方向（通过 `swarm{action:"steer"|"stop"|"title"}` 或 `/swarm steer` 实时重定向子 Agent）。
- **Warm & Disk-Persisted Sessions（温热 + 磁盘持久化会话）**：成员会话落盘至 `.pi/swarm/runs/<run-id>/sessions/`，同进程 `waiting` 保持零 Token 热上下文，即使彻底退出并重启 Pi，下次 `@mention` 仍能从磁盘 JSONL 无损恢复完整对话（自动清理崩溃悬挂 `toolCall`）。
- **Hot Model Switch Auto-Resume & Self-Switch（切模型自动恢复 + 自切延后）**：手动 `swarm{action:"model"}` 切换完立即自动唤醒继续未竟工作；Worker 对自己调用 `swarm{action:"model"}` 会安全排期在当前 turn 结束时切换并立即在新模型上续跑。
- **True Conversation `fork`（真实对话分叉）**：`swarm{action:"add", fork:"<member>|orchestrator"}` 真实继承父成员或主控会话的干净对话历史。
- **Smart LLM Monitor (`stallMonitorMode: "llm"`)**：全部成员空闲超 `stallTimeoutMs` 时，召唤只读诊断官 `@monitor` 分析板子并精准 `@具体卡点成员`（无问题则 `[noop]`，失败自动退化为确定性 `@orchestrator [stall]`）。
- **Independent Read-Only Validator（独立只读验证官）**：`role:"validator"` 强制隔离写工具（仅开放 `read`/`grep`/`find`/`ls` 与只读 `bash` 护栏），杜绝作者自审自过。
- **Share Worktree vs Branch Clone**：`workspace:"share"` 创建共享对象库的 Git worktree，`workspace:"branch"` 创建彻底独立的 `git clone --no-hardlinks`，均支持自动 `autoRebase` 与 `merge`。

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
| **`worker`** | Researchers, scaffolders, parallel authors, helpers (`role:"worker"`) | Default for spawned workers; overridable per `add` or hot-switched while `waiting` |
| **`validator`** | Independent read-only code & test auditors (`role:"validator"`) | Default for spawned validators; overridable per `add` or hot-switched while `waiting` |

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
  "stallTimeoutMs": 45000,
  "autoRebase": true,
  "autoTeardownOnComplete": false
}
```

### 2) Live Control & Hot-Switching (`/swarm model`)

```text
# Inspect 3-role defaults, fallbackModels & live member models (zero LLM turn)
/swarm models

# Persist role defaults to project .pi/pi-swarm-settings.json
/swarm model orchestrator anthropic/claude-opus-4-6 high
/swarm model worker anthropic/claude-sonnet-4-5 medium
/swarm model validator openai/gpt-5.2 high

# Clear a role override back to host default (writes null in project layer to clear global override)
/swarm model worker default

# Hot-switch a warm `waiting` member while keeping 100% of its conversation history!
/swarm model author google/gemini-2.5-pro high
```

On provider HTTP 429 / quota exhaustion, `SwarmEngine` also automatically tries the next untried model in `fallbackModels` on warm `waiting` members before falling back to shared exponential backoff (`RateLimitBreaker`).

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

### Workspace Modes (`inherit` vs `share` vs `branch`)
- **`inherit` (default)**: Runs directly in the shared repository root — ideal for read-only researchers/scouts, validators, or single non-overlapping edits.
- **`share`**: Provisions a linked Git worktree at `.pi/swarm/worktrees/<run-id>/wt-<member>/` on branch `swarm/<run-short>/<member>` sharing the repository's `.git` object store.
- **`branch`**: Provisions a **fully isolated standalone `git clone --no-hardlinks`** at `.pi/swarm/worktrees/<run-id>/wt-<member>/` on branch `swarm/<run-short>/<member>`, fetched back automatically on `swarm{action:"merge"}`.

---

## 命令参考 / Command Reference (`/swarm`)

Only **`/swarm`** and **`/swarm-direct`** are registered on Pi.

| Command (`命令`) | Description (`说明`) | LLM Turn? |
| --- | --- | :---: |
| `/swarm <goal>` | Interactive `pi-goal-x` drafting (`orchestratorModel` → Q&A → plan confirm → Dynamic Swarm) | Yes |
| `/swarm` (bare) | No focused run: start drafting. Focused run: open 0-turn action menu (UI / Status / Board / Graph / Models / Pause-Resume / Done / New / Focus / Settings / Teardown) | No (with run) |
| `/swarm direct <goal>` <br> `/swarm-direct <goal>` | Fast-path: skip Q&A (`autoConfirm: true`), propose plan and launch Dynamic Swarm immediately | Yes |
| `/swarm status` | Zero-turn dashboard: 3-role models, channels, roster table, recent board & events | **No** |
| `/swarm board [limit] [--channel <ch>] [--search <q>]` | Zero-turn shared `#seq` Message Board feed with optional channel & substring filters | **No** |
| `/swarm graph` | Zero-turn ASCII/Unicode Spawn Tree & Peer `@mention` / `#channel` Interaction Graph | **No** |
| `/swarm tasks [tab\|member\|#ch]` <br> `/swarm ui [tab\|member\|#ch]` | Open the live 4-tab Swarm Overlay (**Board** / **Members** / **Graph** / **Search**) | **No** |
| `/swarm models` | Zero-turn overview of 3-role defaults, `fallbackModels`, and every live member's model | **No** |
| `/swarm model <target> <model\|default> [thinking]` | Set role default (`orchestrator`/`worker`/`validator`) OR hot-switch & resume a warm `waiting` member | **No** |
| `/swarm steer <member> <message>` | Steer a working member mid-turn or wake a parked member with new user direction | **No** |
| `/swarm merge <member>` | Land a member's clean `share` worktree or `branch` clone onto `baseBranch` (`autoRebase` + `--no-ff`) | **No** |
| `/swarm kill <member> [--force] [reason]` | Permanently kill a member and remove its clean worktree (`--force` overrides dirty guard) | **No** |
| `/swarm done [summary]` | Complete the active run, dispose warm handles, silence watchdog & restore `idle` tools | **No** |
| `/swarm pause [reason]` / `/swarm resume` | Pause or resume member launches and board wakeups | **No** |
| `/swarm cancel` | Cancel active draft (restores tools) or abandon focused run (preserves worktrees & `.pi/swarm/runs/`) | **No** |
| `/swarm teardown [--force] [--delete-branches]` | Safely remove clean idle worktrees while preserving `.pi/swarm/runs/` audit & board logs | **No** |
| `/swarm runs` | List all runs in `.pi/swarm/runs/` with status, active/waiting counts & board head | **No** |
| `/swarm focus [run-id\|none]` | Switch or detach session-local run focus without hijacking other Pi sessions | **No** |
| `/swarm settings` | View or edit 3-role models, `keepWorkersWarm`, `validatorEnabled`, watchdog, concurrency & git options | **No** |
| `/swarm help` | Print concise command reference | **No** |

---

## TUI 快捷键与 4-Tab 浮层 / TUI Shortcuts & 4-Tab Overlay

### Above-Editor Live Dashboard Widget
- **`Ctrl+Shift+T`**: Toggle between compact beacon (status badge, `O/W/V` model pills, working/waiting counts, latest board line) and expanded live dashboard.
- **`Esc`**: Collapse expanded dashboard (automatically suspended while any modal/overlay is open).

### `/swarm tasks` (`/swarm ui`) 4-Tab Interactive Overlay
- **`1` / `2` / `3` / `4`** or **`Tab` / `Shift+Tab`**: Switch tabs — **[1] Board** · **[2] Members** · **[3] Graph** · **[4] Search**
- **`↑` / `↓`** or **`j` / `k`**: Navigate messages or members
- **Board Tab `[1]`**: **`p`** post a board message (`@mention` / `@#channel`) · **`c`** cycle channel filter (`*` / `#main` / custom channels)
- **Members Tab `[2]`**: **`w`** wake/message selected member · **`m`** hot-switch model (`waiting` member, keeps full history) · **`x`** human-stop member · **`k`** kill member · **`g`** merge `share`/`branch` worktree · **`d`** toggle member details vs Git diff summary
- **Graph Tab `[3]`**: Live Spawn Tree & Peer `@mention` / `#channel` Interaction Graph (`buildSwarmGraphLines`)
- **Search Tab `[4]`**: Live IME substring search across every `#seq` message on the board
- **`Esc` / `q`**: Close overlay cleanly (unsubscribes engine listener & restores terminal cursor)

### Plan Confirmation Modal (`propose_swarm_plan`)
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
│       │   ├── state.json                # Authoritative v2 run, members, channels & roleModels snapshot
│       │   ├── ROSTER.md                 # Auto-rendered human-readable Markdown roster & channel table
│       │   ├── board.jsonl               # Append-only shared #seq Message Board (LF-only JSONL)
│       │   └── events.jsonl              # Append-only audit event ledger (21 event types)
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

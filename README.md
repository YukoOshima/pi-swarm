# 🐝 pi-swarm

**`pi-swarm`** 是面向 [Pi](https://github.com/earendil-works/pi) (`v1.5.2+`) 的**多 Agent 蜂群协作与并行编排扩展（Extension）**，融合了三大核心范式：

- **Antigravity Swarm 式多 Agent 共享协作（Shared Message Board + Warm Persistent Sessions）**：
  - **共享 `#seq` 消息板（`board.jsonl`）**：Orchestrator、Workers 与 Validators 通过带递增序号（`#1`, `#2`…）的共享消息板通信，以 `@mention`（如 `@M2`、`@validator-M2`、`@orchestrator`、`@all`）作为精准唤醒门铃，避免上下文冗余复制与死循环（内置 `SWARM_MAX_BOARD_HOPS = 12` 护栏）。
  - **温热持久会话（Warm Persistent Sessions）**：启用 `keepWorkersWarm` 后，Worker 完成一轮任务后进入低成本 `waiting` 休眠态并保留完整对话历史；当 Validator 提出修复意见或队友 `@mention` 协作时，直接唤醒同一会话实例，无需冷启动重读代码库。
  - **热切换模型（Hot Model Switching）与 3 角色模型路由**：支持为 `orchestrator`、`worker`、`validator` 三类角色分别指定独立模型与推理等级；对处于 `waiting` 状态的 Agent 可通过 `/swarm model <agent> <model>` 或 `swarm_model` **不丢对话历史热切换模型**，并支持配额/429 触发 `fallbackModels` 自动降级。
- **`pi-goal-x` 式事前澄清与计划确认（Interactive Planning）**：启动任何子 Agent 或创建 Git Worktree 之前，先进行只读仓库勘察、通过交互式问答（`swarm_question` / `swarm_questionnaire`）消除歧义，再以可滚动的 Mission DAG 计划书提交用户确认（`propose_swarm_plan`）。
- **独立 Git Worktree 隔离 + 4 层验证与合并门禁（Protocol-Enforced, Not Prompt-Hoped）**：
  - **1 Mission = 1 Branch (`feat/<slug>`) = 1 Git Worktree**：并行 Worker 物理隔离、作用域两两互斥、唯一 Orchestrator 串行 `autoRebase` + `git merge --no-ff`；
  - 从静态计划校验 → 单任务独立只读 Validator → 串行合并门禁 → 合并后 Run 级最终目标审计（Final Validator），每一层均由协议硬性强制执行，尊重人类主权（人工停止的 Agent 永不自动重启，脏 worktree 永不静默删除，跳过最终审计仅限人类通过 `/swarm verify --skip` 执行）。

---

## 3 角色模型配置指南 (3-Role Model Configuration)

`pi-swarm` 将多 Agent 编排拆分为 **3 个正交角色**，可按成本/质量需求分别绑定不同模型与 Thinking Level（未配置时默认继承宿主 Pi 会话模型）：

| 角色 (`role`) | 职责范围 | 生效方式 |
| --- | --- | --- |
| **`orchestrator`** | 主控编排器：交互式规划（Drafting）、Mission DAG 调度、消息板协调、串行合并与异常处理 | 通过 `pi.setModel()` / `pi.setThinkingLevel()` 自动作用于宿主 Pi 会话 |
| **`worker`** | 并行执行者：`build` / `artifact` / `survey` 子任务开发与修复（独立 worktree，温热会话） | 创建/唤醒 Worker `AgentSession` 时应用（支持单次覆盖与热切换） |
| **`validator`** | 独立只读审查与验收：**同时服务于 Per-Mission Validator（单任务 Tip SHA 审查）与 Run-Level Final Validator（合并后整库目标审计）** | 创建 Validator / Final Validator `AgentSession` 时应用 |

### 1) 通过配置文件设置（分层生效）

配置按 **`DEFAULT_SWARM_SETTINGS` ← 全局 (`~/.pi/agent/pi-swarm-settings.json`) ← 项目 (`<cwd>/.pi/pi-swarm-settings.json`)** 合并，所有数值字段自动做安全边界裁剪：

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
  "keepWorkersWarm": true,
  "maxConcurrency": 3,
  "validatorEnabled": true,
  "maxValidationRounds": 3,
  "finalValidatorEnabled": true,
  "maxFinalAuditRounds": 2,
  "autoFixOnAuditFail": true,
  "autoMergeClean": true,
  "autoRebase": true
}
```

### 2) 通过 `/swarm model` 实时调整与热切换

```text
# 查看 3 角色配置 + 当前全部在线/休眠 Agent 的实际模型（零 LLM Turn）
/swarm models

# 设置角色默认模型（持久化写入项目级 .pi/pi-swarm-settings.json，orchestrator 立即切换宿主模型）
/swarm model orchestrator anthropic/claude-opus-4-6 high
/swarm model worker anthropic/claude-sonnet-4-5 medium
/swarm model validator openai/gpt-5.2 high

# 清除某个角色覆盖，恢复继承宿主默认模型
/swarm model worker default

# 对处于 waiting 温热休眠状态的在线 Agent 热切换模型（保留 100% 完整对话历史！）
/swarm model M1 google/gemini-2.5-pro high
```

---

## 4 层验证与门禁架构 (4-Layer Verification & Gate Architecture)

1. **Layer 1 — Plan Validator（计划静态校验器）**：
   - 校验任务依赖图（`deps`）为合法无环 DAG（拒绝缺失依赖或环依赖）；
   - 强制所有 `build` 任务声明**两两互斥的作用域（Disjoint Build Scopes）**，消除并发修改冲突；
   - 强制可打印 ASCII 任务标题并生成唯一的 `feat/<slug>` 分支名。
2. **Layer 2 — Per-Mission Independent Read-Only Validator（单任务独立只读验证官）**：
   - 遵循 **Author ≠ Validator** 原则：每个 `build` 任务提交后，Worker 进入 `waiting` 温热休眠态，独立只读 Validator 绑定精确的 **Tip Commit SHA** 审计变更与任务契约；
   - 若裁决 `fix-then-merge`（发现 `p1`/`p2` 问题），Validator 在共享消息板 `@M<id>` 发帖并**直接唤醒同一温热 Worker 会话**（保留完整上下文）在同一 worktree 内修复，直至 `clean` 或达到 `maxValidationRounds` 升级。
3. **Layer 3 — Serialized Merge Gate（串行合并门禁）**：
   - 遵循 **Author ≠ Validator ≠ Merger** 三权分立，由唯一 Orchestrator 串行执行；
   - 合并前强制校验：worktree 干净、变更文件严格落在声明的 `scope` 内、`build` 任务持有匹配当前 Tip SHA 的 `clean` 验证裁决、`artifact` 交付物持有匹配 Tip SHA 的人工签收（`/swarm approve <id>`）、`survey` 调研任务严格零 diff 结项；
   - 若 `baseBranch` 已前进，自动执行 `autoRebase` 并二次校验 scope 后以 `git merge --no-ff` 合入，随后自动销毁该任务已不再需要的温热会话（`killed`）。
4. **Layer 4 — Run-Level Final Validator / Goal Auditor（Run 级最终验证官）**：
   - 当所有 Mission 均已合入（或放弃）且至少有一个合入任务时，Run 自动进入 `verifying` 状态；
   - 独立的**只读 Final Validator**（使用 `validatorModel`）在干净的 `baseBranch` 集成代码库上按精确 `baseHeadSha` 执行跨任务集成验收与 `verification_contract` 目标审计；
   - 裁决 `approved` 时归档 `audits/audit-r<N>.json` 并完成整个 Run；
   - 裁决 `disapproved` 时：若开启 `autoFixOnAuditFail`、未达 `maxFinalAuditRounds` 且给出合法的 `recommendedMissions`，自动校验并追加修复任务 `F1..Fn`（`final_audit_autofix_planned`），重回 `active` 执行→验证→合并→复审闭环；否则安全停泊等待人工/Orchestrator 介入；
   - **人类主权（Human Sovereignty）**：仅人类可通过 `/swarm verify --skip [reason]` 显式跳过最终验证并结项，Orchestrator 工具 `swarm_verify` 绝不暴露 `skip`。

---

## 快速安装与试用 (Quick Start)

无需构建步骤，Pi 通过 `jiti` 直接加载 TypeScript 源码：

```bash
# 临时加载试用（推荐开发测试）
pi -e /Users/bytedance/Code/pi-swarm

# 或安装为本地 Pi 扩展包
pi install /Users/bytedance/Code/pi-swarm
```

启动后在任意项目目录中输入：

```text
/swarm 重构认证模块并补充完整的集成测试
```

或跳过交互式问答直接勘察并启动编排：

```text
/swarm direct 为 utils/ 添加日期解析与格式化模块并补充单元测试
```

---

## 命令参考 (`/swarm`)

| 命令 | 说明 | 是否触发 LLM Turn |
| --- | --- | :---: |
| `/swarm <goal>` | 进入交互式规划（Drafting 模式）：应用 `orchestratorModel` → 只读勘察 → 澄清提问 → Mission DAG 计划确认 | 是 |
| `/swarm`（无参数） | 若当前会话已聚焦 Run，则打开零成本 TUI/RPC 操作菜单（含 Board、Models、Tasks Overlay、Status、Verify/Skip、Pause/Resume、Settings、Teardown）；否则进入交互式规划 | 否（有 Run 时） |
| `/swarm direct <goal>` <br> `/swarm-direct <goal>` | 快速路径：跳过问答，只读勘察仓库后调用 `propose_swarm_plan` 自动确认并立即启动蜂群 | 是 |
| `/swarm status` | **零 Turn 状态面板**：展示 3 角色模型、按 Wave 分组的任务表、温热 Roster、Recent Board、Final Verification 门禁与近期事件 | **否** |
| `/swarm board [limit]` | **零 Turn 共享消息板**：按 `#seq` 顺序查看最近 `limit` 条（默认 25）消息板协作与 `@mention` 唤醒记录 | **否** |
| `/swarm models` | **零 Turn 模型总览**：展示 `orchestrator` / `worker` / `validator` 角色配置、`fallbackModels` 及全部 Roster Agent 的实时模型与状态 | **否** |
| `/swarm model <target> <model-id\|default> [thinking]` | **零 Turn 模型控制**：`<target>` 为 `orchestrator`/`worker`/`validator` 时更新角色默认并持久化（`default`/`clear` 恢复继承）；为在线 Agent 名（如 `M1`）时对 `waiting` 会话热切换模型并保留完整对话历史 | **否** |
| `/swarm tasks [mission-id]` | 打开交互式 **Swarm Tasks & Board** 浮层，实时查看/操控 Fleet、Logs、Diff 与共享消息板 | **否** |
| `/swarm approve <mission-id>` | 对已完成的 `artifact` 任务执行人工签收（签收精确 Tip SHA，并在开启 `autoMergeClean` 时自动合并） | **否** |
| `/swarm verify [--force]` | 手动触发或强制重跑 `baseBranch` 上的 Run 级只读 Final Validator | **否** |
| `/swarm verify --skip [reason]` | **仅限人类覆盖**：显式跳过 Run 级 Final Validator 并记录跳过原因与审计事件（全部任务终态时直接完成 Run） | **否** |
| `/swarm kill <agent-name-or-id> [reason]` | 永久销毁指定 Agent 并释放其温热持久会话（不可恢复；临时暂停请用 `/swarm pause` 或浮层 `[x]`） | **否** |
| `/swarm pause [reason]` | 暂停新任务调度（已运行的 Agent 继续收尾，不强制中断） | **否** |
| `/swarm resume` | 恢复已暂停的 Run 并继续按 Wave 调度 | **否** |
| `/swarm cancel` | Drafting 期间：取消草案并恢复原工具集；运行/验证期间：确认后停止/销毁活跃与温热 Agent 并标记 Run 为 `abandoned`（保留审计日志、消息板与 worktree） | **否** |
| `/swarm teardown [--force] [--delete-branches]` | 安全清理干净、空闲的 Mission Worktree；默认保留 `.pi/swarm/runs/` 审计与消息板历史；`--force` 强制停机并清理脏 worktree | **否** |
| `/swarm runs` | 列出 `.pi/swarm/runs/` 下的所有历史与活跃 Run | **否** |
| `/swarm focus [run-id\|none]` | 切换或解绑**会话级本地焦点（Session-Local Focus）**，不抢占其他并发会话 | **否** |
| `/swarm settings` | 查看并交互式修改分层配置（含 3 角色模型、`keepWorkersWarm`、并发、Validator、Final Validator、自动修复与合并开关） | **否** |
| `/swarm help` | 打印命令速查表 | **否** |

---

## TUI 快捷键与交互 (TUI Shortcuts)

### 全局快捷键（编辑器聚焦时生效，弹窗打开时自动禁用防止抢键）
- **`Ctrl+Shift+T`**：在编辑器上方 **紧凑状态条（Compact Beacon，含 `O/W/V` 模型胶囊、working/warm waiting 计数与最新 Board 预览）** 与 **展开式 Swarm 仪表盘（Expanded Dashboard）** 之间切换
- **`Esc`**：当上方仪表盘处于展开状态时折叠回紧凑状态条

### `/swarm tasks` 交互浮层按键（Fleet & Board 双视图）
- **`b`**：在 **Fleet（任务/日志/Diff）** 与 **Board（共享 `#seq` 消息板）** 视图间切换
- **`↑` / `↓`** 或 **`k` / `j`**（Board 视图下滚屏）：切换选中的 Mission（含 Run 级 `[FINAL] Final Validator` 条目）
- **`s`**：在 Fleet 视图向活跃 Agent 发送实时 Steering 或唤醒 `waiting` 会话；在 Board 视图直接发帖到共享消息板（支持 `@mention`）
- **`m`**：对选中的 `waiting` Agent 打开行内 IME 输入框，**热切换实时模型**（保留完整历史）
- **`k`**：**永久 Kill** 选中的 Agent 并释放温热会话
- **`x`**：**人工停止（Human-Stop）** 当前活跃 Agent（标记 `humanStopped = true`，编排器永不自动重启）
- **`a`**：人工签收（Approve）选中的 `artifact` Mission
- **`r`**：手动重试（Retry）已失败或已停止的 Mission；选中 `[FINAL]` 时强制重跑 Final Validator
- **`g`**：手动触发该 Mission 的串行合并门禁（Merge Gate）
- **`d`**：在 **实时日志流（Live Log Tail）** 与 **Git Diff 摘要** 之间切换
- **`Esc` / `q`**：关闭浮层

### 计划确认弹窗 (`propose_swarm_plan`) 按键
- **`r`**：切换单任务独立验证门禁（Per-Mission Validator `ON` / `OFF`）
- **`v`**：切换 Run 级最终目标审计门禁（Final Validator `ON` / `OFF`）
- **`+` / `-`**：调整并行并发槽位（`maxConcurrency`）
- **`Enter`**：执行所选操作（`Confirm` 启动 / `Continue refining` 继续讨论 / `Cancel` 放弃草案）
- **`Esc`**：安全返回 `Continue refining`（不会误删草案）

---

## 架构概览 (Architecture)

```text
                 /swarm <goal> (Main Pi Session · orchestratorModel)
                                         │
         ┌───────────────────────────────┴───────────────────────────────┐
         ▼                                                               ▼
 [1. Drafting Phase]                                          [2. Running / Verifying Phase]
 Tool Profile (3 drafting tools):                             Tool Profile (12 orchestrator tools):
  - swarm_question                                             - swarm_status     / swarm_mission
  - swarm_questionnaire                                        - swarm_board_post / swarm_board_read
  - propose_swarm_plan                                         - swarm_spawn      / swarm_model
  (+ read-only host tools)                                     - swarm_kill       / swarm_finding
         │                                                     - swarm_merge      / swarm_verify
         │ Layer 1: Plan Validator                             - swarm_plan_add   / swarm_teardown
         │ (DAG + disjoint build scopes + ASCII branches)                │
         └──────────────────────────────►┌───────────────────────────────┘
                                         ▼
                      SwarmOrchestrator (Event-Driven + Warm Pool)
                  ┌──────────────────────┼──────────────────────┐
                  │                      │                      │
                  ▼                      ▼                      ▼
       Shared Message Board     Wave 1 Workers (workerModel)  RateLimitBreaker
       (board.jsonl · #seq)      ├─ M1 survey (read-only)     + fallbackModels
       @mention wake router      └─ M2 build  (wt-M2, feat/…)   auto-switch
       (hop cap = 12)                   │ git commit → parks in `waiting` (warm)
                  ▲                     ▼
                  │        Layer 2: Per-Mission Validator (validatorModel)
                  │        (read-only, pinned Tip SHA)
                  │          ├─ fix-then-merge ─► posts @M2 on board
                  │          │                    └─► wakes SAME warm M2 session!
                  │          └─ clean ─► Layer 3: Serialized Merge Gate
                  │                      (scope + SHA + autoRebase + --no-ff)
                  │                      └─► auto-kills M2 warm handle
                  │                                    │
                  └────────────────────┬───────────────┘
                                       ▼
                           Wave 2 Workers (deps: [M1, M2])
                           (receives M1 findings + M2 merged code + board excerpt)
                                       │ all missions merged / abandoned
                                       ▼
              Layer 4: Run-Level Final Validator (validatorModel · status: verifying)
              (read-only on clean baseBranch @ exact baseHeadSha)
                ├─ approved ──────────────────────────────────────────────┐
                ├─ disapproved + autoFixOnAuditFail + recommendedMissions │
                │    └─► validate & append F1..Fn ──► back to active loop │
                └─ disapproved (parked, zero tight loop)                  │
                     └─► swarm_plan_add | /swarm verify | /swarm verify --skip (human-only)
                                                                          │
                                                                          ▼
                                          Run completed ──► Settled-Boundary Wakeup (agent_settled)
```

### 模块划分 (`src/`)

- `src/index.ts`：Pi 1.5.2 扩展入口（`createPiSwarmExtension` + 默认导出 `piSwarmExtension`），零工厂副作用延迟绑定、`/swarm` 与 `/swarm-direct` 命令及补全、15 个工具代理注册（3 Drafting + 12 Orchestrator）、`applyOrchestratorModel` 宿主模型同步、`before_agent_start` 尾段注入（`sections.swarm`）、`agent_settled` 唤醒合并与幂等 `session_shutdown`。
- `src/store/`：`SwarmStore`（文件锁 + 乐观版本号 + 原子写入 + Layer 1 DAG/Scope 校验 + `reviews/` & `audits/` 持久化 + 仅限人类的 `skipFinalAudit` 守卫）、`SwarmBoard`（`board.jsonl` 单调 `#seq` 共享消息板与 `@mention` 解析）、`WorktreeManager`（真实 Git Worktree / Auto-Rebase / Merge / Safe Teardown）、`SwarmLedger`（JSONL 事件账本）与分层配置加载器（`pi-swarm-settings.json`）。
- `src/drafting/`：`DraftStateController`（分支局部持久化草案 + 15 工具集幂等切换）、Prompt 构造器（含 3 角色模型与消息板协作规范）与 3 个规划工具。
- `src/runtime/`：`InProcessPiTransport`（基于 Pi 1.5.2 `createAgentSession` 的进程内温热持久会话传输、热切换模型 `session.setModel`、权限与只读护栏）、`SwarmOrchestrator`（3 角色模型解析、波次调度、`@mention` 消息板唤醒路由、温热修复闭环、配额/429 模型自动降级、串行合并门禁、Final Validator 与 `F1..Fn` 自动修复闭环）、`RateLimitBreaker` 与 12 个 Orchestrator 工具。
- `src/ui/`：终端宽度/CJK/ANSI 安全排版工具、`O/W/V` 模型胶囊、交互式问答与计划确认组件、编辑器上方实时仪表盘（`createSwarmWidget`，含 working/waiting warm 状态与最新 Board 预览）、零 Turn 渲染器（`status` / `board` / `models`）与 `/swarm tasks` Fleet & Board 双视图浮层。

---

## `.pi/swarm/` 持久化布局

`pi-swarm` 会自动将 `.pi/swarm/` 写入 `.git/info/exclude`，确保不会污染仓库 `git status`。

```text
<projectRoot>/
├── .pi/
│   ├── pi-swarm-settings.json          # 项目级 3 角色模型与编排配置覆盖（可选）
│   └── swarm/
│       ├── .locks/                     # 单 Run 原子锁（带死进程 PID 回收）
│       ├── runs/<run-id>/
│       │   ├── state.json              # Run、Missions、温热 Roster、3 角色模型与审计权威快照
│       │   ├── board.jsonl             # 共享消息板（单调 #seq、@mentions、handoff/review/model_switch）
│       │   ├── MISSIONS.md             # 每次变更自动同步生成的 Markdown 任务总表（含 3 角色模型与 Final Verification）
│       │   ├── events.jsonl            # 追加式事件审计账本（含 board_posted、agent_woken、agent_model_switched、agent_killed）
│       │   ├── reviews/<id>-rN.json    # 按轮次归档的 Per-Mission Validator 裁决
│       │   ├── audits/audit-r<N>.json  # 按轮次归档的 Run 级 Final Validator 结构化裁决
│       │   ├── findings/<fid>.json     # Survey 与诊断结构化发现
│       │   └── inbox/<agent>.jsonl     # 点对点 Steering/控制消息备份
│       └── worktrees/<run-id>/
│           └── wt-<mission-id>/        # 隔离的 Git Worktree（teardown 时安全移除）
```

---

## 分层配置参考 (Settings)

| 字段 | 默认值 | 范围 / 说明 |
| --- | :---: | --- |
| `orchestratorModel` / `orchestratorThinkingLevel` | `undefined` | 可选覆盖主控 Orchestrator 宿主模型与推理等级（`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`） |
| `workerModel` / `workerThinkingLevel` | `undefined` | 可选覆盖并行 Workers 模型与推理等级 |
| `validatorModel` / `validatorThinkingLevel` | `undefined` | 可选覆盖 Per-Mission Validator 与 Final Validator 统一模型与推理等级 |
| `fallbackModels` | `[]` | 有序备选模型列表，当 Agent 遭遇配额耗尽或 429 时自动尝试热切换降级 |
| `keepWorkersWarm` | `true` | 是否保持 Worker 会话温热（`working` → `waiting`），用于快速 `@mention` 唤醒与保留上下文的评审修复闭环 |
| `maxConcurrency` | `3` | `1–64`，最大并行工作槽位数 |
| `validatorEnabled` | `true` | 是否对 `build` 任务启用 Layer 2 独立只读 Per-Mission Validator 门禁 |
| `maxValidationRounds` | `3` | `1–10`，单任务最大验证修复轮次，超出后升级给 Orchestrator / 人类 |
| `finalValidatorEnabled` | `true` | 是否在全部任务合入后启用 Layer 4 Run 级只读 Final Validator |
| `maxFinalAuditRounds` | `2` | `1–10`，Run 级最终验证最大审计/自动修复轮次，超出后停泊等待人类或 Orchestrator 处理 |
| `autoFixOnAuditFail` | `true` | Final Validator 裁决 `disapproved` 且给出有效 `recommendedMissions` 时，是否自动追加 `F1..Fn` 修复任务并重跑验证 |
| `maxRetries` | `2` | `0–20`，单任务或 Final Validator 瞬态失败最大重试次数 |
| `rateLimitBaseBackoffMs` | `5000` | `250–600000`，HTTP 429 共享退避基础毫秒数 |
| `rateLimitMaxBackoffMs` | `60000` | `250–3600000`，HTTP 429 共享退避上限毫秒数 |
| `gitTimeoutMs` | `30000` | `1000–600000`，单次 Git 子命令超时毫秒数 |
| `autoMergeClean` | `true` | 验证 `clean` / 人工签收 / 零 diff Survey 后是否自动触发串行合并 |
| `autoRebase` | `true` | 合并前若 `baseBranch` 已前进，是否自动执行 `git rebase`（冲突则干净中止并上报） |
| `autoTeardownOnComplete` | `false` | Run 完成后是否自动清理空闲 Worktree |

---

## 开发与测试 (Development & Testing)

```bash
# TypeScript 严格类型检查
npm run typecheck

# 运行全量测试套件（5 个测试文件：store/worktree/board、drafting、ui、orchestrator、E2E integration）
npm test

# 运行单个测试文件
npm run test:file -- tests/integration.test.ts
```

## Why

当前 F:\Agent 项目的 renderer 处于"破而未立"状态：HEAD 中 `App.tsx` 与 `styles.css` 已删，`main.tsx` 仍引用，`ui/components/{composer,topbar,sidebar,settings,main,icons}` 全是空目录。即使补回 HEAD 版本，现有的 `window.agentApi.run()` 也是单回合 IPC —— 用户每次都是新任务，无 thread 列表、无消息流、无工具调用、无中断恢复。

为了让 Agent 框架从"控制台"升级为"会话式 workbench"，必须扩协议（多 turn / tool call / SSE）+ 改 UI（DeepSeek 三段式 Sidebar / Center / Right Inspector）+ 补持久化（JSONL + 索引）。本仓库已存在的 MiniMax 网关与 `domain/agent/ports` 是稳定底座，本次重写在它们之上搭建 workbench 语义，不破坏契约。

## What Changes

- **BREAKING** 删除 `src/renderer/src/ui/App.tsx` 与 `src/renderer/src/styles.css`（git 中已为 D 状态，main.tsx 当前 import 不到）。
- 新建 `src/renderer/src/ui/AppShell.tsx` 作为路由入口（`workbench | settings | initial-setup`），按 `route` 字段条件渲染。
- 新建 `src/renderer/src/ui/styles/tokens.css` 与 `src/renderer/src/ui/styles/shell.css`，按 DeepSeek `DESIGN.md` frontmatter 风格定义 `--ds-*` 变量（light/dark 双套 + 平台适配）。
- 新建 `src/renderer/src/ui/components/{sidebar,topbar,composer,chat,write,inspector,primitives}/` 子目录下的具体组件，参考 DeepSeek 目录结构但只覆盖 Code + Write 两个工作面。
- 扩展 `src/shared/agent-contracts.ts`：新增 `ThreadRecord / TurnRecord / Item / RuntimeEvent / ApprovalRequest` 类型；保留 `AgentRunRequest / AgentRunResponse` 作为旧单回合调用的兼容壳。
- 扩展 `src/shared/ipc.ts`：新增 12+ channel（`THREAD_LIST / THREAD_CREATE / TURN_START / TURN_INTERRUPT / SSE_SUBSCRIBE / APPROVAL_RESPOND / WRITE_LIST / WRITE_GET / WRITE_PUT / WRITE_COMPLETE ...`）。
- 扩展 `src/preload/index.ts`：暴露 `window.agentApi.{threads, turns, sse, approvals, write}`，保持 `window.agentApi.run` 旧签名可调用。
- 改造 `src/main/application/agent-runner.ts`：从单 run 变为多 turn 编排；把 LLM 推理调用迁出主进程到 `src/main/infrastructure/llm-worker/worker.ts`（Node `worker_threads`），主进程只做编排。
- 新建 `src/main/persistence/`：JSONL + 索引实现（`{userData}/threads/{id}/{thread.json, messages.jsonl, events.jsonl}`），原子写。
- 新建 `src/main/event-bus.ts`：把 runtime 事件以 `EventEmitter` 推给 IPC 层，再由 IPC 层 `webContents.send` 推到渲染端。
- 改造 `src/main/index.ts`：注册所有新 IPC 处理器，组装 worker / persistence / event-bus。
- 扩充 `src/renderer/src/i18n/locales/{en,zh-CN}/translation.json`：保留 `layers / traceStages` 命名空间，新增 `chat / write / threads / inspector / approvals / common` 命名空间。
- 新建 `docs/ui-design.md`：本项目自己的 design token 文档（仿 DeepSeek `DESIGN.md` frontmatter 风格），作为视觉权威来源。

## Capabilities

### New Capabilities

- `chat`：Code workbench 的核心交互。包含 thread 列表（Sidebar）、MessageTimeline（多 ChatBlock 类型：user/assistant/reasoning/tool/compaction/approval/user_input/system）、FloatingComposer（输入 + 模型选择 + 工具调用 + 队列消息 + 中断）、Topbar（session 标题 + 工作面切换 + 右侧面板开关）。
- `write`：Write workbench 的核心交互。包含 Markdown 编辑器（textarea + preview）、InlineCompletion（650ms 防抖，96 token 上限）、QuotedSelection（选中文本后调用 agent 返回 Markdown 差异）。
- `runtime`：主进程内多 turn 编排器。基于 `worker_threads` 隔离 LLM 推理，串行处理单 thread 的 turn，跨 thread 并发（受 worker 数限制）。暴露 `start / interrupt / resume / fork` 操作，事件流以 `EventEmitter` 推送。
- `persistence`：JSONL + 索引存储。`ThreadRecord` 原子写，`messages.jsonl` 与 `events.jsonl` append-only，重放时跳过畸形行；`thread.json` 的 relation（`primary` / `fork` / `side`）支持会话族谱。

### Modified Capabilities

无 —— 本项目此前没有 openspec 管理的 spec 目录，全部以新增方式引入。

## Impact

- **代码文件**：
  - 新增：~25 个源文件（4 个 spec 域、UI 子组件、persistence、worker、event-bus）。
  - 修改：`shared/agent-contracts.ts`、`shared/ipc.ts`、`preload/index.ts`、`main/index.ts`、`main/application/agent-runner.ts`、`renderer/src/main.tsx`、`renderer/src/i18n/index.ts`、两个 `translation.json`。
  - 删除（已在 git 中为 D 状态）：`renderer/src/ui/App.tsx`、`renderer/src/styles.css`。
- **依赖**：
  - **不引入** Tailwind / Zustand / React Router。沿用 CSS Modules + React Context + useReducer 模拟 store。
  - **不引入** React Router：用 `route` 字段 + 条件渲染。
  - Node `worker_threads` 为内置，不增加依赖。
- **持久化目录**：`{userData}/threads/{id}/{thread.json, messages.jsonl, events.jsonl}`，卸载应用**不**删除。
- **IPC 表面**：12+ 新 channel；旧 `agentApi.run()` 保留为兼容壳（内部转发到 TURN_START 后台 worker）。
- **i18n**：`zh-CN` + `en` 双语；保留现有 12 个命名空间，新增 6 个。
- **设计文档**：新建 `docs/ui-design.md` 作为视觉权威，与 DeepSeek `DESIGN.md` 风格对齐。
- **窗口 chrome**：macOS 顶栏 inset 42px，Windows/Linux 自绘 title bar 40px。
- **风险**：
  - R1（高）：renderer 全空 → 编写期间可能因类型/导入不全导致 `npm run build` 失败。缓解：阶段 4 之前保留可解析的 `main.tsx`，阶段 4 一气呵成替换。
  - R2（中）：Worker 隔离与主进程类型契约需要 zod 校验。缓解：阶段 1 引入 zod 校验协议。
  - R3（中）：JSONL 写入的并发安全需要原子 rename。缓解：阶段 2 写完即用 `vitest` 单测覆盖。
  - R4（低）：保留旧 `run()` 兼容壳增加 0.5 人天工作量。

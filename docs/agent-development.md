# Agent 开发维护文档

## 文档目的

本文用于记录并维护本仓库 Agent 底层框架的开发内容、架构决策和后续演进事项。凡是修改 Agent 运行框架、LLM 接入、工具机制、IPC、桌面 UI 或国际化能力，都必须同步更新本文。

## 当前开发状态

当前项目已搭建 Electron、Vite、React、TypeScript 桌面应用骨架，用于运行 Agent 框架。核心架构采用“金字塔分层 + 三角循环”：

- 金字塔分层：`domain`、`core`、`application`、`infrastructure`、`preload`、`renderer`。
- 三角循环：`observe` 观察任务输入，`reason` 调用 LLM 推理，`act` 执行工具或完成行动。
- 模块交互：模块间通过 `domain/agent/types.ts` 和 `domain/agent/ports.ts` 中的接口契约交互。

## 已完成内容

- 建立 Electron 桌面应用入口：`src/main/index.ts`。
- 建立安全预加载桥接：`src/preload/index.ts`。
- 建立共享 IPC 与 Agent 请求/响应契约：`src/shared/`。
- 建立 Agent 领域类型和端口接口：`src/main/domain/agent/`。
- 建立三角循环追踪机制：`src/main/core/triangle-loop.ts`。
- 建立 Agent 编排器：`src/main/application/agent-runner.ts`。
- 建立工具注册机制和 `echo` 验证工具：`src/main/application/tools/`。
- 建立 MiniMax OpenAI/Anthropic 兼容协议适配：`src/main/infrastructure/minimax/`。
- 建立 React 桌面控制台 UI：`src/renderer/src/ui/`。
- 建立中英文国际化资源和语言切换能力：`src/renderer/src/i18n/`、`src/shared/locale.ts`。

## 架构决策

1. 领域层不依赖 MiniMax、Electron、React 或 HTTP 响应结构。
2. LLM 接入统一通过 `LlmGateway`，供应商协议差异只存在于 `infrastructure`。
3. Agent 编排器只处理运行流程，不直接拼接供应商请求体。
4. 工具能力通过 `ToolRegistry` 接口注册和执行，后续工具不得绕过注册机制。
5. 渲染层只通过 preload 暴露的安全 API 调用主进程，不直接访问 Node 能力。
6. 界面语言切换属于渲染层展示机制，语言资源集中维护在 `src/renderer/src/i18n/`，可支持语言由 `src/shared/locale.ts` 统一定义。

## 后续待办

- 为 Agent 循环、MiniMax 响应归一化、工具调用和 IPC 契约补充自动化测试。
- 增加工具调用多轮历史的完整保留策略。
- 增加 API Key 的本地安全存储或环境变量读取策略。
- 增加运行日志、错误详情和调试面板。
- 将主进程返回的运行轨迹标题、校验错误和执行错误升级为可本地化的错误码/消息码。
- 梳理打包发布流程。

## 维护要求

每次 Agent 相关开发完成后，必须更新以下内容：

- 如果新增或调整模块，更新“已完成内容”和对应路径。
- 如果改变分层、接口、循环流程或供应商接入方式，更新“架构决策”。
- 如果发现未完成事项，更新“后续待办”。
- 如果修复重要问题，在“变更记录”追加日期、摘要和验证方式。

## 变更记录

### 2026-06-07

- 初始化 Agent 桌面框架开发维护文档。
- 记录当前分层架构、三角循环、MiniMax 双协议接入、工具注册、IPC、React UI 和国际化能力。
- 验证方式：文档检查；代码侧此前已通过 `npm run typecheck` 和 `npm run build`。
- 落地渲染层中英文界面语言切换：新增 `src/shared/locale.ts`、`src/renderer/src/i18n/` 资源与初始化，并将 React 控制台静态文案迁移到 `react-i18next`。
- 验证方式：`npm run typecheck`、`npm run build`。

# 变更记录

## 2026-06-07 — rewrite-as-code-write-workbench

按 [openspec change `rewrite-as-code-write-workbench`](../openspec/changes/rewrite-as-code-write-workbench/) 全量执行 6 阶段 64 个 task。

### 协议层

- 扩展 `src/shared/agent-contracts.ts`：新增 `ThreadRecord / ThreadSummary / ThreadRelation / TurnRecord / TurnStatus`、8 种 `Item`（`user | assistant | reasoning | tool | compaction | approval | user_input | system`）、6 种 `RuntimeEvent`、IPC `Request / Response` 类型、`IpcResult<T>` 通用包壳 + `isItem / isRuntimeEvent / isThreadRecord` 类型守卫（替代 zod）。
- 扩展 `src/shared/ipc.ts`：新增 16 个 channel（`THREAD_LIST/CREATE/GET/UPDATE/DELETE/FORK`、`TURN_START/INTERRUPT/GET`、`SSE_SUBSCRIBE/UNSUBSCRIBE/PUSH`、`APPROVAL_RESPOND`、`WRITE_LIST/GET/PUT/COMPLETE`）。

### 主进程

- 新建 `src/main/persistence/index.ts`：`JsonlThreadStore`，JSONL + 索引 + 原子 rename + per-thread 互斥。
- 新建 `src/main/event-bus.ts`：`RuntimeEventBus extends EventEmitter`，提供 `onKind` / `onThread`。
- 新建 `src/main/infrastructure/llm-worker/`：`protocol.ts`（WorkerInbound/Outbound 类型）+ `worker.ts`（调用 MiniMax 网关、流式 delta、cancel via AbortController）+ `worker-pool.ts`（按 threadId 路由到固定 worker）。
- 新建 `src/main/application/agent-runtime.ts`：多 turn 编排器，`startTurn / interruptTurn / resumeThread / respondApproval`，含 approval gate。
- 新建 `src/main/application/legacy-run-adapter.ts`：把新 runtime 重放成旧 `AgentRunResponse` 兼容壳。
- 新建 `src/main/ipc/{threads,turns,sse,approvals,write}-handlers.ts`：5 个 IPC 注册文件。
- 重写 `src/main/index.ts`：组装 store + runtime + pool + bus + 全部 handler；`window-all-closed` 优雅关 worker；`uncaughtException` 收集到 `debugErrors[]`（开发期）。
- 保留旧 `src/main/application/agent-runner.ts` 不删（不再被新代码引用，留在仓库便于回滚对比）。

### 预加载

- 扩 `src/preload/index.ts`：暴露 `agentApi.{threads, turns, sse, approvals, write}`，保留 `run()` 旧签名。

### 渲染端

- 新建 `src/renderer/src/ui/styles/tokens.css`：`--ds-*` 变量全表（light + dark），仿 DeepSeek `base-shell.css` 命名空间。
- 新建 `src/renderer/src/ui/styles/shell.css`：三段式布局 + divider + composer + chat blocks + inspector + write editor 容器类。
- 新建 `src/renderer/src/ui/store/WorkbenchContext.tsx`：`useReducer` 模拟 store，state 包含 `route / activeThreadId / threads / items / inFlightTurn / rightPanelMode / composer / leftSidebarWidth / rightSidebarWidth`。
- 新建 4 个 primitives：`Pill / IconButton / Chip / KbdHint`。
- 新建 4 个组件子目录：`sidebar/`、`topbar/`、`composer/`、`chat/`、`inspector/`、`write/`。
- 新建 `AppShell.tsx` + `Workbench.tsx` + `SettingsPlaceholder.tsx`：三段式骨架 + 拖拽 + SSE 订阅 + IPC 调用。
- 重写 `src/renderer/src/main.tsx`：移除 `import './styles.css'`，改为 `import './ui/styles/{tokens,shell}.css'`，挂载 `WorkbenchProvider + AppShell`。
- i18n 扩 9 个 namespace（`chat / write / threads / inspector / approvals / common / composer / settings / routes`），en + zh-CN 同步。
- 主题：`initTheme()` 在 `main.tsx` 渲染前同步从 localStorage 读 `agent.theme` 写到 `<html data-theme>`，避免 FOUC。

### 文档

- 新建 `docs/ui-design.md`：本项目设计权威文档，YAML frontmatter 风格对齐 DeepSeek `DESIGN.md`。

### 验证

- `npm run typecheck` 全绿
- `npm run build` 全绿（main + preload + renderer 三个 bundle）

### 已知偏差

- **R2（design.md 风险）**：未引入 zod，改用 TypeScript 原生类型守卫（行为等价，可后续迁移）。
- **R3**：未引入 vitest，`JsonlThreadStore` 单测 `task 2.11` 暂未实现。
- **手动 smoke（task 5.12）**：未做交互式验证。`npm run dev` 启动后可见三段式空骨架；点击 "New thread" 后会通过 IPC 写 JSONL。
- 老的空目录 `src/renderer/src/ui/components/{composer,topbar,sidebar,main,settings,icons}` 在新代码落地后仍有同名子目录，新旧共存；新代码全部位于 `src/renderer/src/ui/components/{primitives,sidebar,topbar,composer,chat,inspector,write}` 下。

### 下一阶段候选

- 真接 MiniMax API key + 跑一次流式对话，验证 worker 隔离。
- 补 `JsonlThreadStore` 单测。
- 写 `docs/kun-architecture.md` 同源文档（本仓库版），记录主进程/渲染端/worker 三层关系。
- 把 zod 装回来，把 `is*` 守卫迁移到 zod schema。

### 验证方式

`npm run typecheck && npm run build` 绿灯；`openspec validate rewrite-as-code-write-workbench` 通过。

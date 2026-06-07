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
- 建立 MiniMax、DeepSeek、自定义 OpenAI-compatible 的供应商感知协议适配：`src/main/infrastructure/minimax/`。
- 建立大模型多配置档案：`src/shared/agent-contracts.ts`、`src/main/persistence/model-config-store.ts`、`src/main/ipc/model-config-handlers.ts`、`src/preload/index.ts`、`src/renderer/src/ui/SettingsView.tsx`，配置保存到 Electron `userData/config` 文件。
- 建立 React 桌面控制台 UI：`src/renderer/src/ui/`。
- 建立中英文国际化资源和语言切换能力：`src/renderer/src/i18n/`、`src/shared/locale.ts`。

## 架构决策

1. 领域层不依赖 MiniMax、Electron、React 或 HTTP 响应结构。
2. LLM 接入统一通过 `LlmGateway`，供应商协议差异只存在于 `infrastructure`。
3. Agent 编排器只处理运行流程，不直接拼接供应商请求体。
4. 工具能力通过 `ToolRegistry` 接口注册和执行，后续工具不得绕过注册机制。
5. 渲染层只通过 preload 暴露的安全 API 调用主进程，不直接访问 Node 能力。
6. 界面语言切换属于渲染层展示机制，语言资源集中维护在 `src/renderer/src/i18n/`，可支持语言由 `src/shared/locale.ts` 统一定义。
7. 大模型运行时仍以 `src/shared/agent-contracts.ts` 中的 `ModelConfig` 作为当前激活配置契约；持久层在外层维护 `ModelConfigProfilesState`（`activeProfileId + profiles[]`），`ModelConfigStore.get()` 只返回当前激活档案的 `ModelConfig`，避免 Agent 运行循环感知多档案 UI。
8. LLM 网关按 `ModelConfig.model_provide` 做供应商感知请求体分流：`MiniMax` 使用 `max_completion_tokens/reasoning_split/thinking.type=adaptive|disabled`，`DeepSeek` 使用 `/chat/completions`、`max_tokens/thinking.type=enabled|disabled/reasoning_effort=high|max`，其他供应商走通用 OpenAI-compatible 请求体。


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

## 2026-06-07 — 启动错误修复

- 修复 preload 启动错误：`electron.vite.config.ts` 将 preload 打包产物输出为 CommonJS `out/preload/index.js`，`src/main/index.ts` 的 BrowserWindow preload 路径同步改为 `../preload/index.js`，保留 `contextIsolation: true` 与 `nodeIntegration: false`。
- 修复开发期 CSP 与 Vite React Refresh 冲突：主进程按开发/生产环境注入 CSP，开发期允许 Vite 所需 inline preamble，生产期保持 `script-src 'self'`。
- 修复渲染端 Context 重复实例风险：统一 `src/renderer/src/ui/Workbench.tsx` 对 `WorkbenchContext` 的本地导入，不再使用 `.js` 后缀混用。
- 修复 LLM worker 启动错误：把 `src/main/infrastructure/llm-worker/worker.ts` 加为 main 构建入口，输出 `out/main/llm-worker.js`；`worker-pool.ts` 使用该稳定入口。
- 验证方式：`npm run typecheck`、`npm run build`、`npm run dev` 短时启动；启动日志标准错误输出为空。

## 2026-06-07 — 聊天发送流程修复

- 修复 `window.prompt()` 在 Electron 渲染端中不可用导致的新建会话崩溃：`src/renderer/src/ui/Workbench.tsx` 新建会话直接使用空工作区。
- 修复无活动会话时发送消息静默失败：发送前自动创建线程、订阅该线程的 SSE，再调用 `turns.start`。
- 修复自动创建首个线程时早期 runtime event 可能丢失：渲染端维护活动线程 ref，SSE listener 常驻，线程切换时只更新主进程订阅。
- 验证方式：`npm run typecheck`、`npm run build`、`npm run dev` 短时启动；启动日志标准错误输出为空。
- 落地大模型配置设置：新增 `ModelConfig` 契约、`config:model:get/update` IPC、`ModelConfigStore` 持久化到 `userData/config`、设置页表单和运行时配置读取；MiniMax 网关改为使用配置的 `base_url/max_tokens/thinking`。
- 验证方式：`npm run typecheck`、`npm run build`。
- 扩展大模型多配置档案：`config` 文件由单个 `ModelConfig` 自动迁移为 `ModelConfigProfilesState`；新增配置档案 list/create/update/delete/activate IPC 和 preload API；设置页新增档案卡片区，表单继续编辑当前激活配置。
- 扩展供应商感知 LLM 请求：运行时传递 `model_provide/model_reasoning_effort`；API key 回退逻辑改为 DeepSeek 读取 `DEEPSEEK_API_KEY`、MiniMax 读取 `MINIMAX_API_KEY`，最后回退 `OPENAI_API_KEY`；网关按 MiniMax、DeepSeek、自定义供应商方言构造请求体。
- 验证方式：`npm run typecheck`、`npm run build`。

# 变更记录

## 2026-06-07 — rewrite-as-code-write-workbench

按 [OpenSpec 变更 `rewrite-as-code-write-workbench`](../openspec/changes/rewrite-as-code-write-workbench/) 全量执行 6 阶段 64 个任务。

### 协议层

- 扩展 `src/shared/agent-contracts.ts`：新增 `ThreadRecord / ThreadSummary / ThreadRelation / TurnRecord / TurnStatus`、8 种 `Item`（`user | assistant | reasoning | tool | compaction | approval | user_input | system`）、7 种 `RuntimeEvent`、IPC `Request / Response` 类型、`IpcResult<T>` 通用包壳 + `isItem / isRuntimeEvent / isThreadRecord` 类型守卫（替代 zod）。
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

- 新建 `src/renderer/src/ui/styles/tokens.css`：`--ds-*` 变量全表（light + dark），作为本项目统一设计 token 命名空间。
- 新建 `src/renderer/src/ui/styles/shell.css`：三段式布局 + divider + composer + chat blocks + inspector + write editor 容器类。
- 新建 `src/renderer/src/ui/store/WorkbenchContext.tsx`：`useReducer` 模拟 store，state 包含 `route / activeThreadId / threads / items / inFlightTurn / rightPanelMode / composer / leftSidebarWidth / rightSidebarWidth`。
- 新建 4 个 primitives：`Pill / IconButton / Chip / KbdHint`。
- 新建 4 个组件子目录：`sidebar/`、`topbar/`、`composer/`、`chat/`、`inspector/`、`write/`。
- 新建 `AppShell.tsx` + `Workbench.tsx` + `SettingsView.tsx`：三段式骨架 + 拖拽 + SSE 订阅 + IPC 调用。
- 重写 `src/renderer/src/main.tsx`：移除 `import './styles.css'`，改为 `import './ui/styles/{tokens,shell}.css'`，挂载 `WorkbenchProvider + AppShell`。
- i18n 扩展 9 个命名空间（`chat / write / threads / inspector / approvals / common / composer / settings / routes`），英文与中文同步。
- 主题：`initTheme()` 在 `main.tsx` 渲染前同步从 localStorage 读 `agent.theme` 写到 `<html data-theme>`，避免首次渲染主题闪烁。

### 文档

- 新建 `docs/ui-design.md`：本项目设计权威文档，记录 UI token、布局语法与后续维护约束。

### 验证

- `npm run typecheck` 全绿
- `npm run build` 全绿（main + preload + renderer 三个 bundle）

### 已知偏差

- **R2（design.md 风险）**：未引入 zod，改用 TypeScript 原生类型守卫（行为等价，可后续迁移）。
- **R3**：未引入 vitest，`JsonlThreadStore` 单测 `task 2.11` 暂未实现。
- **手动冒烟（task 5.12）**：未做交互式验证。`npm run dev` 启动后可见三段式空骨架；点击“New thread”后会通过 IPC 写 JSONL。
- 老的空目录 `src/renderer/src/ui/components/{composer,topbar,sidebar,main,settings,icons}` 在新代码落地后仍有同名子目录，新旧共存；新代码全部位于 `src/renderer/src/ui/components/{primitives,sidebar,topbar,composer,chat,inspector,write}` 下。

### 下一阶段候选

- 真接 MiniMax API key + 跑一次流式对话，验证 worker 隔离。
- 补 `JsonlThreadStore` 单测。
- 写 `docs/kun-architecture.md` 同源文档（本仓库版），记录主进程/渲染端/worker 三层关系。
- 把 zod 装回来，把 `is*` 守卫迁移到 zod schema。

### 验证方式

`npm run typecheck && npm run build` 绿灯；`openspec validate rewrite-as-code-write-workbench` 通过。

## 2026-06-07 — LLM 流式输出

- 扩展 `src/main/domain/agent/types.ts`：`LlmGateway` 新增 `stream(request, options)`，以 `LlmStreamChunk` 表达 `text_delta`、`reasoning_delta`、`tool_call_delta`、`tool_call_completed`、`usage`、`completed` 与 `error`。
- 扩展 `src/main/infrastructure/minimax/minimax-gateway.ts`：OpenAI-compatible 请求使用 `stream: true`、`stream_options.include_usage` 与 `text/event-stream`，解析 SSE `data:` 帧和 `[DONE]`；Anthropic-compatible 请求解析 `content_block_delta`、`message_delta` 与工具 JSON 增量。
- 扩展 `src/main/infrastructure/llm-worker/`：worker 通过 `gateway.stream(..., { signal })` 逐块发送结构化 delta，`cancel` 通过 `AbortController` 终止 HTTP 流；`worker-pool` 的 `onChunk` 传递 `LlmStreamChunk` 而不是裸字符串。
- 扩展 `src/shared/agent-contracts.ts` 与 `src/main/event-bus.ts`：`RuntimeEvent` 新增 `item_updated`，用于把流式中的 assistant/reasoning item 推给订阅 renderer。
- 扩展 `src/main/application/agent-runtime.ts`：运行时收到 `text_delta` / `reasoning_delta` 后懒创建同一 turn 的 live item，持续 emit `item_updated`；流结束或中断时把最终/截断 item 写入 JSONL 并 emit `item_appended`，保证 UI 当前态、持久化重放和旧 `runOnce` 兼容壳一致。
- 扩展 `src/renderer/src/ui/Workbench.tsx` 与 `src/renderer/src/ui/store/WorkbenchContext.tsx`：renderer 订阅 `item_updated` 并按 item id upsert，`item_appended` 同样 upsert，避免流式最终落盘事件造成重复气泡。
- 验证方式：`npm run typecheck`、`npm run build`。

## 2026-06-07 - 输入框、计划、目标、附件与用量

- 扩展 `src/shared/agent-contracts.ts`：新增 `TurnMode`、`ThreadGoal`、`GoalUpdateRequest`、`AttachmentRecord`、`AttachmentCreateRequest`、`PlanItem`、`UsageDailyBucket`，并让 `TurnStartRequest` 支持 `modelProfileId`、`mode`、`goalMode` 与 `attachmentIds`。
- 扩展 `AgentRuntime`：每轮请求使用 turn 上的 `reasoningEffort`；按 `modelProfileId` 解析模型配置，显式 profile 不存在时失败；Plan 模式注入计划系统指令；Goal 模式注入目标系统指令；图片附件读取后以多模态 content blocks 发送给 LLM；`turn_completed` 事件携带 usage。
- 扩展工具机制：`ToolRegistry.execute()` 增加 `AgentToolContext`；新增 `create_plan` 工具生成持久化 `PlanItem`；新增 `update_goal` 工具更新 `ThreadRecord.goal` 并广播 `goal_updated`；`create_plan` 只在 plan mode 暴露并免 approval，`update_goal` 只在 goal mode 或 active goal thread 暴露并免 approval；工具完成、失败或被拒绝后通过 `item_updated` 推送最终 `ToolItem`。
- 新增附件存储与 IPC：`AttachmentStore` 写入 Electron `userData/attachments`，附件索引写入串行化；`attachments.create/get/delete` 通过 preload 暴露给 renderer，renderer 不直接访问文件系统；composer 删除附件会同步删除未发送附件文件，发送成功后的历史附件不删除。
- 新增 Goal 与 Usage IPC：`goals.update` 更新当前 thread 目标；`usage.daily` 从持久化 runtime events replay usage 并按日聚合。
- 扩展 LLM 网关消息转换：`AgentMessage.content` 支持文本与图片 blocks；OpenAI-compatible 映射为 `text/image_url`，Anthropic-compatible 映射为 `text/image`。
- 扩展 renderer：`FloatingComposer` 增加 `+` 菜单、图片上传、Plan 模式、Goal 模式、模型 profile picker 与 per-turn reasoning picker；`MessageTimeline` 空态显示最近用量热力图；`RightInspector` 的 Plan 面板显示最新计划。
- 同步 i18n：新增 composer、empty、usage、common on/off 文案，并修正 zh-CN 占位问号文案。
- 修复 `turns.get` 持久化 replay：同 id item 保留最后版本，避免流式 item 或工具 item 终态重放时重复显示。
- 验证方式：`npm run typecheck`；`npm run build` 若本地 Rollup optional dependency 缺失，需要先修复 `node_modules` 后重试。
## 2026-06-07 - 设置页 UI 中心化

- 将设置路由实现替换为 `src/renderer/src/ui/SettingsView.tsx`。
- 在 `src/renderer/src/ui/components/settings/` 下新增设置页专用渲染端组件：`SettingsSidebar.tsx` 和 `SettingsControls.tsx`。
- 设置页现在使用左侧导航栏、受约束的右侧内容列、卡片分组、行式控件、API Key 密文控制，以及明确的“就绪 / 已修改 / 保存中 / 已保存 / 需要处理”状态反馈。
- 更新 `src/renderer/src/ui/styles/shell.css` 中的设置页样式，以及 `src/renderer/src/i18n/locales/{en,zh-CN}/translation.json` 中的设置页文案。
- 验证方式：`npm run typecheck`；`npm run build`。

## 2026-06-07 - 线程删除 UI

- 为侧边栏线程新增渲染端删除操作。该操作使用现有 `agentApi.threads.delete(id)` preload API 和 `THREAD_DELETE_CHANNEL` IPC 路径。
- 删除的线程如果是当前活动线程，删除成功后渲染端会清空当前线程、时间线、运行中的 turn 状态和右侧面板选择。
- 当前正在运行的线程会在渲染端阻止删除，直到 turn 停止，避免运行时继续向已移除的线程目录写入数据。
- `thread:delete` 在删除持久化 JSONL 数据前，也会在主进程检查 `AgentRuntime.isThreadInFlight(threadId)`，因此过期的渲染端状态不能删除仍在运行的非活动线程。
- 更新侧边栏样式，以及删除确认和运行中 turn 防护的英文/中文 i18n 文案。
- 验证方式：`npm run typecheck`；`npm run build`。

## 2026-06-07 - 工作区选择器与线程归档

- 新增 `workspace:pick-directory` 作为 renderer 到 main 的 IPC channel。主进程打开 Electron 目录选择器，并通过现有 `IpcResult<T>` 包壳返回 `{ canceled, path }`；preload 将其暴露为 `agentApi.workspace.pickDirectory()`。
- `ThreadRecord` 和 `ThreadSummary` 现在携带 `status: "active" | "archived"`。`JsonlThreadStore.createThread()` 将新线程写为 active，读取缺少 status 的旧线程 JSON 时会归一化为 active。
- `threads.list()` 默认隐藏已归档线程，并支持 `includeArchived` / `archivedOnly`。用量聚合会包含归档线程，因此历史用量仍会被统计。
- Code 模式创建会话现在需要工作区目录。新建聊天和首次发送自动创建线程时会使用当前 `workspaceRoot`；如果尚未选择，渲染端会先打开工作区选择器。
- Code 侧边栏按 `ThreadSummary.workspace` 对线程行分组，提供工作区切换按钮；切换后会选择该工作区中最近的线程，或创建一个新线程。
- 线程归档/恢复通过 `threads.update(id, { status })` 实现。归档活动线程会清空渲染端选择并取消 SSE 订阅。主进程和渲染端都会阻止归档存在 in-flight turn 的线程。
- 硬删除保持独立：`threads.delete(id)` 会移除持久化线程目录，并继续阻止删除 in-flight 线程。
- Write 模式不再使用 `window.prompt`；它复用工作区选择器和共享的渲染端 `workspaceRoot` 状态执行 list/get/put 文件操作。
- 更新侧边栏/写作模式样式，以及工作区切换、归档/恢复、归档可见性和写作刷新相关英文/中文 i18n 文案。
- 验证方式：`npm run typecheck`；`npm run build`。

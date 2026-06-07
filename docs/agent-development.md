# Agent 开发维护文档

## 文档目的

本文用于记录并维护本仓库 Agent 底层框架的开发内容、架构决策和后续演进事项。凡是修改 Agent 运行框架、LLM 接入、工具机制、IPC、桌面 UI 或国际化能力，都必须同步更新本文。

## 当前开发状态

当前项目已搭建 Electron、Vite、React、TypeScript 桌面应用骨架，用于运行 Agent 框架。核心架构采用“分层架构 + 多 turn runtime”：

- 分层：`domain`、`application`、`infrastructure`、`preload`、`renderer`。
- 主运行时：`AgentRuntime` 负责多 turn 编排、LLM worker 调用、工具闭环、approval gate、JSONL 持久化和事件广播。
- 旧单次运行入口、旧响应 trace 契约和旧编排器已经下线，当前运行时只有多 turn 路径。
- 模块交互：模块间通过 `domain/agent/types.ts` 和 `domain/agent/ports.ts` 中的接口契约交互。

## 已完成内容

- 建立 Electron 桌面应用入口：`src/main/index.ts`。
- 建立安全预加载桥接：`src/preload/index.ts`。
- 建立共享 IPC 与 Agent 请求/响应契约：`src/shared/`。
- 建立 Agent 领域类型和端口接口：`src/main/domain/agent/`。
- 建立多 turn Agent 编排器：`src/main/application/agent-runtime.ts`。
- 建立工具注册机制和 `echo` 验证工具：`src/main/application/tools/`。
- 建立 MiniMax、DeepSeek、自定义 OpenAI-compatible 的供应商感知协议适配：`src/main/infrastructure/minimax/`。
- 建立大模型多配置档案：`src/shared/agent-contracts.ts`、`src/main/persistence/model-config-store.ts`、`src/main/ipc/model-config-handlers.ts`、`src/preload/index.ts`、`src/renderer/src/ui/SettingsView.tsx`，配置保存到 Electron `userData/config` 文件。
- 建立 React 桌面控制台 UI：`src/renderer/src/ui/`。
- 建立中英文国际化资源和语言切换能力：`src/renderer/src/i18n/`、`src/shared/locale.ts`。
- 建立 Vitest 自动化测试体系：`vitest.config.ts`、`tsconfig.test.json`、`tests/`，覆盖共享契约、主进程持久化、模型配置、附件、工具、事件总线、LLM 网关、AgentRuntime 和渲染端 reducer。

## 架构决策

1. 领域层不依赖 MiniMax、Electron、React 或 HTTP 响应结构。
2. LLM 接入统一通过 `LlmGateway`，供应商协议差异只存在于 `infrastructure`。
3. Agent 编排器只处理运行流程，不直接拼接供应商请求体。
4. 工具能力通过 `ToolRegistry` 接口注册和执行，后续工具不得绕过注册机制。
5. 渲染层只通过 preload 暴露的安全 API 调用主进程，不直接访问 Node 能力。
6. 界面语言切换属于渲染层展示机制，语言资源集中维护在 `src/renderer/src/i18n/`，可支持语言由 `src/shared/locale.ts` 统一定义。
7. 大模型运行时仍以 `src/shared/agent-contracts.ts` 中的 `ModelConfig` 作为当前激活配置契约；持久层在外层维护 `ModelConfigProfilesState`（`activeProfileId + profiles[]`），`ModelConfigStore.get()` 只返回当前激活档案的 `ModelConfig`，避免 Agent 运行循环感知多档案 UI。
8. LLM 网关按 `ModelConfig.model_provide` 做供应商感知请求体分流：`MiniMax` 使用 `max_completion_tokens/reasoning_split/thinking.type=adaptive|disabled`，`DeepSeek` 使用 `/chat/completions`、`max_tokens/thinking.type=enabled|disabled/reasoning_effort=high|max`，其他供应商走通用 OpenAI-compatible 请求体。
9. 自动化测试使用 Vitest，优先测试公开类、共享契约和纯状态逻辑；持久化测试使用临时目录隔离，LLM 网关测试通过 mock `fetch` 验证请求体和 SSE 解析，不依赖真实 API key。


## 维护要求

每次 Agent 相关开发完成后，必须更新以下内容：

- 如果新增或调整模块，更新“已完成内容”和对应路径。
- 如果改变分层、接口、循环流程或供应商接入方式，更新“架构决策”。
- 如果发现未完成事项，更新“后续待办”。
- 如果修复重要问题，在“变更记录”追加日期、摘要和验证方式。

## 测试与验证

- `npm run test`：运行 Vitest 自动化测试。
- `npm run typecheck`：同时检查 renderer/shared、main/preload/shared 和测试源码。
- `npm run build`：构建 Electron main、preload 与 renderer 产物。
- 新增或修改 Agent 运行框架、LLM 接入、工具、IPC、持久化、UI 状态或 i18n 时，应优先补充对应 `tests/` 用例，再运行上述命令。

## 变更记录

### 2026-06-07

- 初始化 Agent 桌面框架开发维护文档。
- 记录当前分层架构、多 turn runtime、MiniMax 双协议接入、工具注册、IPC、React UI 和国际化能力。
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
- 新建 `src/main/ipc/{threads,turns,sse,approvals,write}-handlers.ts`：5 个 IPC 注册文件。
- 重写 `src/main/index.ts`：组装 store + runtime + pool + bus + 全部 handler；`window-all-closed` 优雅关 worker；`uncaughtException` 收集到 `debugErrors[]`（开发期）。
- 旧单次运行编排器与 trace 机制已无主路径入口，当前已移除。

### 预加载

- 扩 `src/preload/index.ts`：暴露 `agentApi.{threads, turns, sse, approvals, write}`。

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
- **R3**：已在 2026-06-07 的测试补充中引入 Vitest，并补充 `JsonlThreadStore` 自动化测试。
- **手动冒烟（task 5.12）**：未做交互式验证。`npm run dev` 启动后可见三段式空骨架；点击“New thread”后会通过 IPC 写 JSONL。
- 老的空目录 `src/renderer/src/ui/components/{composer,topbar,sidebar,main,settings,icons}` 在新代码落地后仍有同名子目录，新旧共存；新代码全部位于 `src/renderer/src/ui/components/{primitives,sidebar,topbar,composer,chat,inspector,write}` 下。

### 下一阶段候选

- 真接 MiniMax API key + 跑一次流式对话，验证 worker 隔离。
- 写 `docs/kun-architecture.md` 同源文档（本仓库版），记录主进程/渲染端/worker 三层关系。
- 把 zod 装回来，把 `is*` 守卫迁移到 zod schema。

### 验证方式

`npm run typecheck && npm run build` 绿灯；`openspec validate rewrite-as-code-write-workbench` 通过。

## 2026-06-07 — LLM 流式输出

- 扩展 `src/main/domain/agent/types.ts`：`LlmGateway` 新增 `stream(request, options)`，以 `LlmStreamChunk` 表达 `text_delta`、`reasoning_delta`、`tool_call_delta`、`tool_call_completed`、`usage`、`completed` 与 `error`。
- 扩展 `src/main/infrastructure/minimax/minimax-gateway.ts`：OpenAI-compatible 请求使用 `stream: true`、`stream_options.include_usage` 与 `text/event-stream`，解析 SSE `data:` 帧和 `[DONE]`；Anthropic-compatible 请求解析 `content_block_delta`、`message_delta` 与工具 JSON 增量。
- 扩展 `src/main/infrastructure/llm-worker/`：worker 通过 `gateway.stream(..., { signal })` 逐块发送结构化 delta，`cancel` 通过 `AbortController` 终止 HTTP 流；`worker-pool` 的 `onChunk` 传递 `LlmStreamChunk` 而不是裸字符串。
- 扩展 `src/shared/agent-contracts.ts` 与 `src/main/event-bus.ts`：`RuntimeEvent` 新增 `item_updated`，用于把流式中的 assistant/reasoning item 推给订阅 renderer。
- 扩展 `src/main/application/agent-runtime.ts`：运行时收到 `text_delta` / `reasoning_delta` 后懒创建同一 turn 的 live item，持续 emit `item_updated`；流结束或中断时把最终/截断 item 写入 JSONL 并 emit `item_appended`，保证 UI 当前态与持久化重放一致。
- 扩展 `src/renderer/src/ui/Workbench.tsx` 与 `src/renderer/src/ui/store/WorkbenchContext.tsx`：renderer 订阅 `item_updated` 并按 item id upsert，`item_appended` 同样 upsert，避免流式最终落盘事件造成重复气泡。
- 验证方式：`npm run typecheck`、`npm run build`。

## 2026-06-07 - DeepSeek tokens cache telemetry 与前缀稳定

- 扩展 `TokenUsage` / `AgentUsage` / `TurnRecord.usage` / `UsageDailyBucket`：usage 现在支持 `cacheHitTokens`、`cacheMissTokens`、`cacheHitRate`，`usage.daily` 按日累计 hit/miss 后用 `hit / (hit + miss)` 计算命中率。
- 扩展 OpenAI-compatible usage 解析：优先读取供应商原生 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`；原生字段缺失时，才 fallback 到 `prompt_tokens_details.cached_tokens` 或 `cache_read_input_tokens` 并用 prompt tokens 估算 miss。
- 稳定 LLM 请求前缀：`AgentRuntime` 的基础 `systemPrompt` 固定不再拼入 plan/goal/current goal 等运行态内容；这些动态指令改为插入到当前用户消息之前的后置 system message，降低首段 prefix 漂移。
- 稳定工具 catalog：`MiniMaxGateway` 在发送 OpenAI-compatible 与 Anthropic-compatible tools 前，按工具名排序并递归排序 `inputSchema` key，避免同一工具集合因注册顺序或 schema key 顺序不同破坏 provider prefix cache。
- 增加发送前 history hygiene：`AgentRuntime` 会在构造模型请求时压缩历史中的超大工具结果、长字符串参数、base64 参数和超长数组；该处理只影响发给模型的 `LlmRequest.messages`，不改写 JSONL 持久化历史。
- `model_auto_compact_token_limit` 现在参与发送前消息预算：当估算请求 token 超过阈值时，运行时会保留最近动态消息和当前用户输入，丢弃更早动态消息；这是轻量级保护，不替代后续可由模型生成摘要的完整上下文压缩器。
- 验证方式：`npm test -- tests/main/infrastructure/minimax-types.test.ts tests/main/infrastructure/minimax-gateway.test.ts tests/main/application/agent-runtime.test.ts tests/main/ipc/usage-handlers.test.ts`、`npm run typecheck`、`npm run build`。

### 2026-06-07 二次优化

- `AgentRuntime` 现在在 turn 消息初始化时插入 plan/goal 运行态上下文，并把它放在历史消息之前；工具多轮请求会复用同一个消息数组，确保上一轮请求消息序列是下一轮请求的前缀。
- 历史 tool result fallback、OpenAI-compatible assistant tool call `function.arguments`、Anthropic-compatible `tool_use.input` 都采用 canonical JSON key 顺序，减少对象 key 插入顺序对请求字节的影响。
- 空态用量热力图现在会显示最近窗口的 cache hit rate，并在每日 tooltip 中显示 hit/miss 口径，方便观察 DeepSeek tokens cache 优化是否生效。
- 验证方式：`npm test -- tests/main/application/agent-runtime.test.ts tests/main/infrastructure/minimax-gateway.test.ts tests/main/infrastructure/minimax-types.test.ts tests/main/ipc/usage-handlers.test.ts`、`npm run typecheck`、`npm run build`。

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

## 2026-06-07 - 自动化测试体系

- 新增 Vitest 测试运行器和 `npm run test` 脚本，并新增 `tsconfig.test.json`，使测试源码参与 `npm run typecheck`。
- 新增 `tests/` 分层测试：共享契约与 IPC allowlist、`JsonlThreadStore`、`ModelConfigStore`、`AttachmentStore`、工具注册与输入校验、`RuntimeEventBus`、MiniMax/DeepSeek/custom LLM 网关请求体和 SSE 解析、`AgentRuntime` 主流程与渲染端 `WorkbenchContext` reducer。
- 修复测试暴露出的持久化并发问题：`AttachmentStore`、`JsonlThreadStore`、`ModelConfigStore` 初始化改为 single-flight；线程索引和模型配置写入增加串行化，避免并发写入同一临时文件造成 Windows rename 失败或索引丢失。
- `WorkbenchContext` 导出 `INITIAL_STATE`、`Action` 和 `reducer`，用于测试纯状态转移；渲染端运行行为不变。
- 验证方式：`npm run test`、`npm run typecheck`、`npm run build`。

## 2026-06-07 - 大模型输出展示与工具闭环

- 扩展 `AgentRuntime` 工具循环：模型返回 tool calls 后，运行时执行工具、把 assistant tool call 和 tool result 追加进后续 `LlmRequest.messages`，最多执行 6 轮，直到模型产出最终回答；工具失败会发出 `runtime_error(code: "tool_failed")`，不会静默吞错。
- 扩展工具上下文：`AgentToolContext` 新增 `workspace`，新增只读工作区工具 `list_files`、`read_file`、`search_files`，并在 `src/main/index.ts` 注册；这些工具只允许访问当前线程 workspace，默认跳过 `.git`、`DeepSeek`、`node_modules`、`out` 等非项目源码或构建目录。
- 扩展 LLM 消息转换：`AgentMessage` 支持 assistant `toolCalls`，OpenAI-compatible 与 Anthropic-compatible 请求构造都会把历史 tool call / tool result 转成供应商可理解的结构。
- 优化 renderer 时间线：`MessageTimeline` 先按 `turnId` 分组，再将 reasoning、工具调用、过程性 assistant 文本归入可折叠“工作过程”，最终 assistant 文本作为 Markdown 正文显示；工具项显示本地化标题、状态和可展开详情。
- 新增渲染端 Markdown 支持：`AssistantMarkdown` 使用 `react-markdown` + `remark-gfm` 渲染段落、列表、代码块和表格；新增中英文 `chat` 文案与 `shell.css` 中的 Markdown / 工作过程样式。
- 新增测试覆盖：`tests/renderer/timeline-model.test.ts` 覆盖 turn 分组与工具摘要，`tests/main/application/tools.test.ts` 覆盖工作区只读工具边界，`tests/main/application/agent-runtime.test.ts` 覆盖工具结果回灌后的二次模型请求。
- 验证方式：`npm run typecheck`、`npm run test`；`npm run build`。

## 2026-06-07 - 旧单次运行入口下线

- 删除旧单次运行公开 API：preload 不再暴露 `run()`，shared IPC allowlist 不再包含旧 channel，shared contract 不再保留旧请求/响应/trace 类型。
- 删除旧兼容适配器及其专用测试；`AgentRuntime.startTurn()` 回到公开 `TurnStartRequest` 契约，不再保留只服务旧入口的内部 API key override。
- 主进程组合根只注册多 turn、SSE、approval、goal、attachment、usage、workspace、write 和 model config 相关 IPC handler。
- 更新项目维护文档和协作者指南，明确当前只有多 turn runtime，不要恢复旧单次运行分支。
- 验证方式：`npm run test`、`npm run typecheck`、`npm run build`。

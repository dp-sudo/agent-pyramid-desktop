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
- 建立工具注册机制：`src/main/application/tools/`。
- 建立首批 coding agent 写入工具：`read_file` 会记录文件读状态；`edit_file` / `write_file` 使用共享 workspace 路径策略、读后未过期校验和结构化 diff preview，经 approval gate 后写入工作区文本文件；`apply_patch` 支持受限 unified diff dry-run、多文件 diff preview 和一次性提交；`rollback_file` 可回滚当前 app 会话内最近一次 agent 文件写入。
- 建立首批命令执行工具：`run_command` 在 active workspace 内运行前台 shell 命令，支持 workspace-relative `cwd`、timeout、stdout/stderr 截断、结构化结果和 turn interrupt 取消。
- 建立首批诊断工具：`diagnose_workspace` 在 active workspace 内运行 TypeScript/typecheck 并解析结构化错误；`diagnose_file` 使用 TypeScript Language Service 对单文件做语法/语义/建议诊断，用于编辑后的 workspace 级与文件级验证闭环。
- 建立 MiniMax、DeepSeek、自定义 OpenAI-compatible 的供应商感知协议适配：`src/main/infrastructure/minimax/`。
- 建立大模型多配置档案：`src/shared/agent-contracts.ts`、`src/main/persistence/model-config-store.ts`、`src/main/ipc/model-config-handlers.ts`、`src/preload/index.ts`、`src/renderer/src/ui/SettingsView.tsx`，配置保存到 Electron `userData/config` 文件。
- 建立 React 桌面控制台 UI：`src/renderer/src/ui/`。
- 设置页采用两级导航：顶部切换设置大类，左侧切换当前大类下的小类，中间展示详细配置；当前“基础设置”大类承载外观与语言、启动与布局、会话与工作区偏好，“大模型设置”大类承载模型档案、连接信息、上下文和推理行为。
- 建立中英文国际化资源和语言切换能力：`src/renderer/src/i18n/`、`src/shared/locale.ts`。
- 建立 Vitest 自动化测试体系：`vitest.config.ts`、`tsconfig.test.json`、`tests/`，覆盖共享契约、主进程持久化、模型配置、附件、工具、事件总线、LLM 网关、AgentRuntime 和渲染端 reducer。

## 架构决策

1. 领域层不依赖 MiniMax、Electron、React 或 HTTP 响应结构。
2. LLM 接入统一通过 `LlmGateway`，供应商协议差异只存在于 `infrastructure`。
3. Agent 编排器只处理运行流程，不直接拼接供应商请求体。
4. 工具能力通过 `ToolRegistry` 接口注册、预览和执行，后续工具不得绕过注册机制；工具用 metadata 声明只读、破坏性和类别，runtime 基于 metadata、`approvalPolicy` 与 `sandboxMode` 做审批/拒绝决策。
5. 渲染层只通过 preload 暴露的安全 API 调用主进程，不直接访问 Node 能力。
6. 界面语言和主题切换属于渲染层展示机制，语言资源集中维护在 `src/renderer/src/i18n/`，可支持语言由 `src/shared/locale.ts` 统一定义；设置页“基础设置”直接调用渲染层 localStorage 偏好，不进入主进程运行时配置。
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

### 2026-06-08 — coding-agent 文件写入能力首批落地

- 扩展工具契约：`AgentTool` 支持 `metadata` 与 `preview()`，`AgentToolResult` 支持 `displayResult`，`ToolRegistry` 支持按名称取工具；runtime 在 approval 前可生成结构化预览，并把模型可读结果和 UI 展示结果分离。
- 新增共享 workspace 路径策略：`src/main/application/tools/workspace-policy.ts` 统一处理 lexical path、realpath、父目录 realpath、symlink 与 skipped path 校验，避免读写工具路径策略漂移。
- 新增读状态：`FileReadStateStore` 记录 `read_file` 读取到的内容、mtime、size、sha256 与截断状态；`edit_file` / `write_file` 对现有文件要求先完整读取，且写前确认文件未被外部修改。
- 新增 coding tools：`edit_file` 使用 `old_string/new_string/replace_all` 精确替换，默认要求唯一匹配；`write_file` 支持新建文件和显式 `overwrite: true` 覆盖现有文件；两者都返回结构化 file diff。
- 强化 runtime policy：只读工具免审批；`create_plan` / `update_goal` 继续按模式免审批；`sandboxMode: read-only` 和 `approvalPolicy: never` 会拒绝写入类工具；需要审批的写入工具会在 approval item/event 上携带 diff preview。
- 扩展 renderer：approval block 会展示文件 diff 预览；工具摘要识别 `edit_file` / `write_file`；中英文 i18n 同步新增写入工具和 diff 操作文案。
- 当前已实现 TypeScript/typecheck 的 workspace 级诊断与 TypeScript Language Service 文件级诊断；常驻 LSP server、增量诊断和多语言诊断可后续增强。
- 验证方式：新增 Vitest 覆盖 workspace/read-state/edit/write/runtime approval preview/renderer summary；完整验证命令见本次实现记录。

### 2026-06-08 — coding-agent 命令执行能力落地

- 新增 `src/main/application/tools/command-tools.ts`：注册 `run_command` 工具，命令必须在 active workspace 内以前台方式执行，`cwd` 走共享 workspace realpath/path escape 策略。
- 扩展工具上下文：`AgentToolContext.signal` 由 runtime 注入，`AgentRuntime.interruptTurn()` 会 abort 当前 turn 的 active tool controllers，使命令工具能随 turn interrupt 取消。
- 命令结果不把非零退出码包装成工具异常，而是返回结构化 `exitCode/signal/timedOut/durationMs/stdout/stderr/*Truncated`，让模型可以根据真实命令结果继续决策。
- runtime policy 保持统一：`run_command` 是 `category: "command"`、`isDestructive: true` 的命令工具；因为 shell 命令可修改文件或执行任意脚本，默认需要 approval，线程 `approvalPolicy: "auto"` 不会自动放行，`sandboxMode: "read-only"` 与 `approvalPolicy: "never"` 会拒绝。
- 扩展 renderer：工具摘要识别 `run_command`，中英文 i18n 新增命令工具文案。
- 当前已实现 TypeScript/typecheck 的 workspace 级诊断与 TypeScript Language Service 文件级诊断；常驻 LSP server 可后续增强。
- 验证方式：新增 Vitest 覆盖 command cwd 越界/symlink escape/非目录 cwd/timeout/stdout stderr 截断/runtime approval/runtime interrupt/renderer summary；完整验证命令见本次实现记录。

### 2026-06-08 — coding-agent 补丁应用能力落地

- 扩展 `createCodingTools()`：新增 `apply_patch` 工具，输入为 `{ patch: string }`，支持常见 unified diff/git diff 的 `---` / `+++` 文件头和 `@@` hunk；当前范围限定为 create/update 文本文件，不支持删除、重命名和二进制 patch。
- `apply_patch` 先解析并 dry-run 所有文件，要求更新现有文件前已通过 `read_file` 建立新鲜读状态；任一 hunk 不匹配、路径越界或目标不合法时，整批 patch 不写入任何文件。
- 扩展 approval preview：`ApprovalPreview` 新增 `multi_file_diff`，renderer approval block 复用现有 diff UI 展示多文件变更；工具摘要和中英文 i18n 识别 `apply_patch`。
- `apply_patch` 继续走 runtime policy：作为 destructive workspace tool 默认需要审批，`sandboxMode: "read-only"` 和 `approvalPolicy: "never"` 会在执行前拒绝。
- 当前已实现 TypeScript/typecheck 的 workspace 级诊断与 TypeScript Language Service 文件级诊断；常驻 LSP server、增量诊断和多语言诊断可后续增强。
- 验证方式：新增 Vitest 覆盖 patch create/update、多文件 dry-run 失败不写入、路径越界、runtime 多文件 diff approval preview 和 renderer summary；完整验证命令见本次实现记录。

### 2026-06-08 — coding-agent 文件历史与回滚能力落地

- 新增 `FileHistoryStore`：runtime 为写入类工具提供进程内文件历史，记录 agent 写入前后内容、sha256、工具名、turnId 和 workspace-relative path；当前历史随 app 进程生命周期存在，不跨重启持久化。
- `edit_file`、`write_file`、`apply_patch` 在 commit 后记录历史；`rollback_file` 使用最近一条历史恢复写入前内容。新建文件的回滚会删除文件，更新文件的回滚会恢复旧内容。
- 回滚前会校验当前文件 sha256 是否仍等于历史中的 afterSha256，避免覆盖用户或外部进程在 agent 写入后的新改动。
- `rollback_file` 是 destructive workspace tool，默认进入 approval gate，并复用 file diff preview；回滚本身也会记录历史，允许误回滚后再次回滚。
- 当前已实现 TypeScript/typecheck 的 workspace 级诊断与 TypeScript Language Service 文件级诊断；常驻 LSP server、增量诊断和多语言诊断可后续增强。
- 验证方式：新增 Vitest 覆盖 update 回滚、create 回滚、缺失 history、stale current 拒绝、runtime approval preview、renderer summary；完整验证命令见本次实现记录。

### 2026-06-08 — coding-agent 诊断能力落地

- 扩展 `createCommandTools()`：新增 `diagnose_workspace` / `diagnose_file` 工具。`diagnose_workspace` 会执行 workspace script/tsc，按命令工具进入 approval gate；`diagnose_file` 只使用 TypeScript Language Service 读取文件诊断，保持只读免审批。
- `diagnose_workspace` 在 workspace 内优先运行 `npm run typecheck`；如果 package.json 没有 `scripts.typecheck`，fallback 到 `npx tsc --noEmit`。
- `diagnose_file` 先校验目标文件在 workspace 内且是 UTF-8 文本文件，再用 TypeScript Language Service 读取 tsconfig 并返回目标文件的 syntactic/semantic/suggestion diagnostics，给模型提供更接近 IDE/LSP 的文件级入口。
- `typescript` 从 devDependency 移为 runtime dependency，因为 main 进程工具在运行时直接使用 TypeScript Language Service API。
- 工具返回 `path/line/column/code/severity/message/source` 结构化 diagnostics；`diagnose_workspace` 同时保留命令、退出码、timeout 和输出截断状态。
- 当前实现是 TypeScript/typecheck workspace 诊断 + TypeScript Language Service 文件诊断，不是常驻 LSP server；后续如需更接近 IDE 的体验，可引入 tsserver/LSP 进程管理、增量诊断和多语言 adapter。
- 验证方式：新增 Vitest 覆盖 package typecheck 诊断解析、fallback tsc 诊断解析、文件级诊断过滤、diagnose_file 路径边界、diagnose_workspace approval/never policy、runtime read-only 免审批和 renderer summary；完整验证命令见本次实现记录。

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
- 重写 `src/main/index.ts`：组装 store + runtime + pool + bus + 全部 handler；`window-all-closed` 优雅关 worker；`uncaughtException` / `unhandledRejection` 写入主进程日志（开发期）。
- 旧单次运行编排器与 trace 机制已无主路径入口，当前已移除。

### 预加载

- 扩 `src/preload/index.ts`：暴露 `agentApi.{threads, turns, sse, approvals, write}`。

### 渲染端

- 新建 `src/renderer/src/ui/styles/tokens.css`：`--ds-*` 变量全表（light + dark），作为本项目统一设计 token 命名空间。
- 新建 `src/renderer/src/ui/styles/shell.css`：三段式布局 + divider + composer + chat blocks + inspector + write editor 容器类。
- 新建 `src/renderer/src/ui/store/WorkbenchContext.tsx`：`useReducer` 模拟 store，state 包含 `route / activeThreadId / threads / items / inFlightTurn / rightPanelMode / composer / leftSidebarWidth / rightSidebarWidth / basicPreferences`。
- 新建 4 个 primitives：`Pill / IconButton / Chip / KbdHint`。
- 新建 4 个组件子目录：`sidebar/`、`topbar/`、`composer/`、`chat/`、`inspector/`、`write/`。
- 新建 `AppShell.tsx` + `Workbench.tsx` + `SettingsView.tsx`：三段式骨架 + 拖拽 + SSE 订阅 + IPC 调用。
- 重写 `src/renderer/src/main.tsx`：移除 `import './styles.css'`，改为 `import './ui/styles/{tokens,shell}.css'`，挂载 `WorkbenchProvider + AppShell`。
- i18n 扩展 9 个命名空间（`chat / write / threads / inspector / approvals / common / composer / settings / routes`），英文与中文同步。
- 主题：`initTheme()` 在 `main.tsx` 渲染前同步从 `src/renderer/src/ui/preferences.ts` 的 `agent-pyramid.basicPreferences` 读主题偏好，支持浅色、深色和跟随系统主题，并写到 `<html data-theme>` 避免首次渲染主题闪烁。

### 文档

- 新建 `docs/ui-design.md`：本项目设计权威文档，记录 UI token、布局语法与后续维护约束。

### 验证

- `npm run typecheck` 全绿
- `npm run build` 全绿（main + preload + renderer 三个 bundle）

### 已知偏差

- **R2（design.md 风险）**：未引入 zod，改用 TypeScript 原生类型守卫（行为等价，可后续迁移）。
- **R3**：已在 2026-06-07 的测试补充中引入 Vitest，并补充 `JsonlThreadStore` 自动化测试。
- **手动冒烟（task 5.12）**：未做交互式验证。`npm run dev` 启动后可见三段式空骨架；点击“New thread”后会通过 IPC 写 JSONL。
- 老的空目录 `src/renderer/src/ui/components/{main,icons}` 已清理；当前 UI 组件集中在 `src/renderer/src/ui/components/{primitives,sidebar,topbar,composer,chat,inspector,write,settings}` 下。

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
- `model_auto_compact_token_limit` 现在参与发送前消息预算：运行时会从 `model_auto_compact_token_limit`、`model_context_window - max_tokens` 和 0.95 safety ratio 解析有效输入预算；模型配置持久层拒绝 `max_tokens >= model_context_window`，避免输出预算挤占完整输入窗口。超预算时先做历史 tool result / 参数 hygiene，再按消息段裁剪旧动态历史，最后对必须保留的当前上下文做渐进式 UTF-8 安全压缩，并用 `[context budget: ...]` 标记被省略内容。该处理只影响发给模型的请求，不改写 JSONL 持久化历史，也不替代后续可由模型生成摘要的完整上下文压缩器。
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

## 2026-06-08 - 基础设置完整化

- 新增 `src/renderer/src/ui/preferences.ts` 作为渲染端基础偏好的唯一权威来源，集中维护 localStorage key、默认值、类型守卫和宽度范围。
- 设置页“基础设置”扩展为“外观与语言 / 启动与布局 / 会话与工作区”三组：支持界面语言、界面主题、跟随系统主题、默认启动视图、记住左右面板宽度、默认 Inspector 面板、默认显示归档会话、启动时恢复上次工作区和删除会话二次确认。
- `WorkbenchContext` 从基础偏好派生初始 route、workspaceRoot、归档显示、Inspector 面板和左右宽度；设置页修改偏好后会即时同步到工作台状态。
- 侧栏删除会话根据 `confirmThreadDelete` 决定是否显示 inline 二次确认；写作工作台补充返回编码工作台和进入设置页的导航，避免默认启动写作视图后缺少返回路径。
- 验证方式：`npm run typecheck`；`npm run test`；`npm run build`。

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

- 扩展 `AgentRuntime` 工具循环：模型返回 tool calls 后，运行时执行工具、把 assistant tool call 和 tool result 追加进后续 `LlmRequest.messages`，按模型档案的 `agent_autonomy` 选择工具预算（conservative 12、balanced 32、deep 64），也可通过 `AGENT_MAX_TOOL_ROUNDS` 在 1 到 128 之间覆盖；运行时接近预算时会向模型注入纠偏提示，耗尽后会记录未执行 tool call 的 failed tool result、发出 `tool_budget_reached` 事件，并把 turn 标记为 `needs_continuation`，方便用户继续线程而不是把体验等同于失败；工具失败会发出 `runtime_error(code: "tool_failed")`，不会静默吞错。
- 扩展工具上下文：`AgentToolContext` 新增 `workspace`，新增只读工作区工具 `list_files`、`read_file`、`search_files`，并在 `src/main/index.ts` 注册；这些工具只允许访问当前线程 workspace，默认跳过 `.git`、`DeepSeek`、`node_modules`、`out` 等非项目源码或构建目录。
- 扩展 LLM 消息转换：`AgentMessage` 支持 assistant `toolCalls`，OpenAI-compatible 与 Anthropic-compatible 请求构造都会把历史 tool call / tool result 转成供应商可理解的结构。
- 优化 renderer 时间线：`MessageTimeline` 先按 `turnId` 分组，再将 reasoning、工具调用、过程性 assistant 文本归入可折叠“工作过程”，最终 assistant 文本作为 Markdown 正文显示；工具项显示本地化标题、状态和可展开详情。
- 新增渲染端 Markdown 支持：`AssistantMarkdown` 使用 `react-markdown` + `remark-gfm` 渲染段落、列表、代码块和表格；新增中英文 `chat` 文案与 `shell.css` 中的 Markdown / 工作过程样式。
- 新增测试覆盖：`tests/renderer/timeline-model.test.ts` 覆盖 turn 分组与工具摘要，`tests/main/application/tools.test.ts` 覆盖工作区只读工具边界，`tests/main/application/agent-runtime.test.ts` 覆盖工具结果回灌后的二次模型请求。
- 验证方式：`npm run typecheck`、`npm run test`；`npm run build`。

## 2026-06-08 - 写作文件服务边界与死代码清理

- 修复 `write` IPC 文件服务：`write.list/get/put` 现在统一拒绝 `.git`、`.idea`、`.vscode`、`DeepSeek`、`dist`、`node_modules`、`out` 等非项目源码或构建目录，避免 Write 模式列出或写入第三方参考资料与构建产物。
- 加固 `write.get/put` 路径边界：读写前会校验目标或最近存在父目录的 realpath 仍位于 workspace 内，防止工作区内符号链接指向外部文件后被读取或覆盖。
- 修复 `write.list` 目录遍历错误处理：无法读取工作区或子目录时不再静默返回空结果，而是通过 `WRITE_LIST_FAILED` envelope 暴露可追踪错误。
- 完善 Write 模式基础交互：文件列表支持搜索过滤，编辑器按 800ms debounce 自动保存，`write.complete` 提供本地 Markdown 列表/引用续写建议，渲染端支持 650ms completion debounce、Tab 接受与 Escape 取消。
- 修复 Write 模式自动保存竞态：同一文件保存请求串行化，保存中继续编辑会在前一轮完成后再写入最新内容，避免旧请求晚返回覆盖新内容。
- 修复 Write 模式文件搜索竞态：`write.list` 搜索/刷新请求现在按渲染端请求序号只应用最新响应，避免慢返回的旧搜索结果覆盖新文件列表。
- 修复 approval IPC 边界：`approval:respond` 现在统一返回 `IpcResult` envelope，非法 decision 和不存在的 approvalId 会返回可追踪错误，渲染端会把失败显示到现有错误区域，不再静默当作成功。
- 修复 usage 统计缓存边界：`usage:daily` 的短 TTL 缓存现在按 `JsonlThreadStore` 实例隔离，避免测试、多实例或未来多数据目录场景中按 days 复用导致统计串数据。
- 修复 `JsonlThreadStore` per-thread mutex 清理 no-op：串行队列完成后会按 tail Promise 引用删除对应 threadId 槽，避免长期操作大量线程后保留已完成队列。
- 修复 SSE 订阅生命周期：同一 `webContents` 反复切换 thread subscription 时会清理上一条 destroyed listener，避免窗口销毁监听器累积。
- 修复 LLM worker 退出路径：`LlmWorkerPool.chat()` 现在监听当前请求的 worker `exit`，worker 异常退出但未发送错误消息时会 reject 并释放请求状态，避免 turn 永久悬挂。
- 补充 AgentRuntime 同线程并发门禁测试：同一 thread 已有 in-flight turn 时，第二个 `startTurn()` 会在追加用户消息前以 `RUNTIME_TURN_BUSY` 失败。
- 修复 AgentRuntime 启动失败清理：`startTurn()` 在追加初始用户消息失败时会清理 in-flight 状态并发出 `persistence_error` / `turn_failed`，避免线程永久 busy。
- 修复 AgentRuntime 中断竞态：`interruptTurn()` 现在先将内存 turn 状态标记为 interrupted，再取消 worker；如果 cancel 让 worker 请求立即 abort，后台循环会按用户中断收尾而不是误报 failed。中断提示项写入失败会发出 `persistence_error`，但仍继续完成 interrupted 状态清理。
- 修复 approval 决策持久化错误可见性：resolved approval item 写入失败不再 fire-and-forget 静默丢失，会发出 `persistence_error`，同时继续 resolve 决策避免 turn 卡住。
- 修复 renderer IPC 结果处理：Workbench 现在检查 `sse.subscribe`、`sse.unsubscribe` 和 `turns.interrupt` 的 `IpcResult`，订阅或中断失败会显示到现有错误区域。
- 修复 Workbench 初始加载错误可见性：启动时 `threads.list`、`modelConfig.get`、`modelConfig.listProfiles` 的失败不再被静默忽略，会合并显示到现有错误区域。
- 修复 FloatingComposer 草稿同步：Code composer 会跟随全局 `composer.text` 更新，避免 Write 模式写入草稿后切回 Code 仍显示旧本地 draft。
- 修复 FloatingComposer 弹层收束：`+` 菜单和模型选择器打开时会响应 composer 外部 `pointerdown` 与 `Escape` 自动关闭，添加图片入口触发文件选择后也会立即收起菜单，避免弹层长期悬浮遮挡时间线。
- 修复 FloatingComposer 附件-only 发送：当 composer 有图片附件但文本为空时，发送按钮和 Enter 提交会使用本地化默认提示创建 turn，并把 `displayText`、新 thread 标题与 LLM 输入文本保持一致；真正空白且无附件的草稿仍不可发送。
- 修复模型选择器高亮：当多个 profile 使用同一 model 字符串时，Composer 优先按 `modelProfileId` 高亮唯一档案，避免多 profile 同时显示为选中。
- 修复模型 profile 状态同步：`WorkbenchContext` 会在 active profile 真实切换或当前 profile 被删除时同步 composer 到新 active profile；普通 profile 列表刷新会保留用户当前有效选择，并刷新该 profile 的最新模型和 reasoning 配置，避免 `model` 文本与 `modelProfileId` 错位。
- 优化大模型输出 Markdown 渲染：`AssistantMarkdown` 继续使用 `react-markdown` + `remark-gfm`，但新增链接、代码块、表格、任务列表、图片和分隔线的稳定容器/样式映射，长代码和宽表格在中心内容列内横向滚动，外链打开新窗口。
- 优化代码块交互：Assistant Markdown 代码块顶部栏显示语言或默认代码标签，并提供复制按钮；剪贴板不可用或写入失败时显示失败反馈，不影响消息渲染。
- 优化流式输出滚动：`MessageTimeline` 在用户停留于底部附近时自动跟随最新 `item_updated` / `item_appended` 内容；用户上滑阅读旧内容后停止抢滚动，回到底部后恢复跟随。
- 优化工作过程展开状态：`MessageTimeline` 仍默认展开当前运行 turn 的 work process，但会按 turnId 保留用户手动展开/折叠选择，避免流式更新时重置阅读状态。
- 优化线程侧栏交互：删除会话从系统 `window.confirm` 改为行内确认态，线程主区域改为真实 button，归档/恢复/删除操作独立成 action 区，减少误触并提升键盘焦点可见性。
- 优化 Write 工作台交互：文件列表增加加载、未打开工作区、无 Markdown 文件和搜索无结果状态；文件行改为真实 button 并显示大小/日期元信息；搜索框支持一键清空；保存按钮在无文件、无变更或忙碌状态下禁用并显示已保存状态。
- 优化工作台基础可控性：左侧分栏 separator 支持键盘焦点、Arrow/Home/End 调宽并复用鼠标拖拽宽度边界；聊天错误提示改为可关闭 toast，不再只能等待下一次状态覆盖。
- 优化 RightInspector 交互：右侧分析面板增加左边缘 resizer，支持鼠标拖拽与 Arrow/Home/End 键盘调宽，宽度范围遵循 `docs/ui-design.md` 的 280 到 760；检查器空状态和变更列表样式从内联样式收敛到 `shell.css`。
- 优化 RightInspector 分析内容：Changes 面板复用工具摘要展示工具标题、状态和参数/结果详情；Todo 面板从待审批、失败工具、运行错误与最新计划未完成步骤派生可操作事项；Plan 面板显示最新计划进度与步骤状态。
- 优化 approval 交互：审批按钮点击后进入本地提交中状态并禁用 allow/deny，避免 IPC 返回或事件更新前重复提交；approval 参数 JSON 使用固定样式与滚动区域展示。
- 优化 Settings 模型档案交互：删除 profile 改为卡片内行内确认态，提供确认/取消和删除中反馈，避免单击误删模型配置。
- 加固 Settings 未保存修改保护：模型档案表单处于 dirty 状态时会阻止激活、创建、复制、删除 profile 和返回工作台，并显示保存提示；保存按钮在 idle/saved/loading/saving 时禁用，避免无变更保存。
- 扩展 Settings 基础设置：新增“基础设置”大类，并完整提供“外观与语言 / 启动与布局 / 会话与工作区”三组偏好；这些偏好选择后立即生效并保存到渲染端 localStorage，不复用大模型配置保存状态。
- 修复附件存储输入校验：`AttachmentStore` 现在严格校验 `dataBase64`，非法 base64 不会被 `Buffer.from(..., "base64")` 宽松解码后保存为损坏附件。
- 修复附件创建失败副产物：`AttachmentStore.create()` 在附件二进制写入后如果索引更新失败，会删除刚创建的 `.bin` 文件并原样抛出错误，避免留下孤儿附件。
- 加固本地持久化 ID 边界：`JsonlThreadStore` 和 `AttachmentStore` 在解析 thread / attachment 本地路径前校验 UUID，阻止 renderer 或损坏数据传入 `../` 之类路径片段访问、写入或删除持久化目录外文件。
- 加固线程持久化输入校验：`JsonlThreadStore.createThread/listThreads/updateThread` 现在会在写入或过滤前校验 workspace、mode、relation、status、approvalPolicy、sandboxMode、goal 等运行时输入，避免坏 IPC 数据写入 index/thread JSON。
- 修复线程创建失败副产物：`JsonlThreadStore.createThread()` 在新线程目录和 JSONL 文件创建后，如果索引写入失败，会删除本次新建线程目录并原样抛出错误，避免留下未索引线程数据。
- 加固 workspace 工具符号链接边界：`list_files` 和 `search_files` 会跳过符号链接条目，避免通过工作区内 symlink 暴露或遍历工作区外内容；`read_file` 继续使用 realpath 校验阻止 symlink 文件读取越界。
- 修复 OpenAI-compatible 流式工具调用收尾：provider 以 `stop` 或 `[DONE]` 结束但已发送完整 tool call delta 时，`MiniMaxGateway` 会 flush pending tool call，避免 runtime 静默丢失工具调用。
- 修复 Anthropic-compatible 流式工具调用收尾：兼容服务缺少 `content_block_stop` 但以 `message_delta` / `[DONE]` 结束时，`MiniMaxGateway` 会 flush 已累积的 pending tool call。
- 修复 LLM SSE reader 清理可追踪性：释放 SSE reader lock 失败时会记录带上下文的 warning，不再使用静默空 catch 分支。
- 修复工具注册边界：`InMemoryToolRegistry.register()` 现在拒绝重复工具名，避免组合根或测试接线错误被后注册工具静默覆盖。
- 加固 `update_goal` 目标机制：工具清除目标改为显式 `clear: true`，空字符串或非字符串 `goal` 不再被静默解释为清除；归档线程拒绝 goal 更新；`complete` / `blocked` 时间戳只在首次进入对应终态时写入，后续编辑 summary 或文本不会刷新终态时间；renderer 仅处理当前 active thread 的 `goal_updated` 事件。
- 优化 workspace 搜索工具容错：`search_files` 的 `path` 现在既可指向目录，也可指向单个 UTF-8 文本文件；单文件路径会只搜索该文件，避免模型把文件路径传给搜索工具时反复得到 `path is not a directory` 并触发工具轮数上限。
- 优化 AgentRuntime 自动工具预算：固定 6 轮硬限制升级为模型档案 `agent_autonomy` 三档策略（保守 12、平衡 32、深度 64），仍可通过 `AGENT_MAX_TOOL_ROUNDS` 覆盖；运行时会在预算后段提示模型收敛或避免重复失败工具，预算耗尽时会把最后一批未执行 tool call 记录为 failed tool result，发出 `tool_budget_reached`，并以 `needs_continuation` 结束当前 turn。
- 清理未使用的 worker protocol helper、worker-pool 类型守卫和 main 入口的无消费者 gateway re-export。
- 新增 `tests/main/ipc/write-handlers.test.ts` 覆盖 Markdown 列表过滤、path escape、跳过目录策略和不可读工作区错误。
- 验证方式：`npm test`、`npm run typecheck`、`npm run build`。

## 2026-06-07 - 旧单次运行入口下线

- 删除旧单次运行公开 API：preload 不再暴露 `run()`，shared IPC allowlist 不再包含旧 channel，shared contract 不再保留旧请求/响应/trace 类型。
- 删除旧兼容适配器及其专用测试；`AgentRuntime.startTurn()` 回到公开 `TurnStartRequest` 契约，不再保留只服务旧入口的内部 API key override。
- 主进程组合根只注册多 turn、SSE、approval、goal、attachment、usage、workspace、write 和 model config 相关 IPC handler。
- 更新项目维护文档和协作者指南，明确当前只有多 turn runtime，不要恢复旧单次运行分支。
- 验证方式：`npm run test`、`npm run typecheck`、`npm run build`。

## 2026-06-08 - 维护审计与旧调试工具清理

- 清理生产运行时旧验证工具：删除 `echo` 调试工具源码，主进程组合根只注册 `create_plan`、只读 workspace 工具和 `update_goal`，注册表行为改由测试内本地 tool double 覆盖。
- 优化工具调用错误分类：模型请求未在当前 turn 工具 catalog 中暴露的工具时，`AgentRuntime` 现在发出 `runtime_error(code: "tool_not_found")`，不再混用泛化 `internal`。
- 修复 LLM worker 池恢复路径：worker 异常退出后会清除指向死亡 worker 的 thread affinity / cancel 映射并创建 replacement worker，避免后续同线程 turn 继续投递到已退出 worker。
- 清理静态分析发现的死引用：移除未使用的 React import、store 构造参数属性和 write handler 未使用参数。
- 修复中断状态机边缘情况：用户中断已经写入 `interrupted` 终态后，后台 partial stream 持久化失败只发出可追踪 `runtime_error(code: "persistence_error")`，不会再把同一 turn 覆盖为 `failed`。
- 修复模型配置迁移兼容性：读取旧单配置或旧 profiles 状态时，过大的 `model_auto_compact_token_limit` 会被收敛到 `model_context_window`，与旧 `max_tokens` 收敛策略一致；用户主动保存新配置仍保持严格校验。
- 验证方式：`npm run typecheck`、`npm run test`、`npm run build`。

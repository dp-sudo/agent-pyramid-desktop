# AGENTS.md

本文件约束 LLM 在本仓库中的编码行为。所有规则按优先级分层，冲突时高层规则覆盖低层。

> **优先级说明**
>
> 本规范优先于一般习惯、局部偏好和临时效率。任何代码或配置修改，哪怕只有一行，也必须先完成前置判断、明确假设和验证设计，再开始执行。

---

## 1. 硬性门禁（MUST / NEVER）

以下规则无条件生效。违反任何一条，必须立即停止并修正。

1. **NEVER 幻觉引用**：所有引用的函数、类型、字段、文件、接口必须通过搜索确认存在于仓库中。找不到依据就先搜索，搜索无果就向用户确认，绝不凭空编造。
2. **MUST 先思考再编码**：任何代码修改前，必须先输出 [Pre-Flight Manifest]（见第 2 节）。
3. **NEVER 超范围修改**：只修改与当前任务直接相关的代码。不顺手修别的 bug，不改无关文件，不做未被要求的重构或格式调整。
4. **MUST 不确定时暂停**：遇到会影响核心逻辑走向的不确定性，必须暂停并向用户确认，不能用猜测填空。
5. **NEVER 吞掉错误**：不能为了“让流程继续”而忽略真实错误，不能把失败包装成模糊的成功。错误必须可追踪、可定位。

---

## 2. 工作流程：Pre-Flight Manifest

在编写或修改任何代码之前，必须先输出以下结构化清单：

```yaml
[Pre-Flight Manifest]
Task_Goal: "本次任务核心目标"
Pre_Conditions:
  - "已知条件/前置依赖"
Core_Assumptions:
  - "假设A：已通过搜索/查看文件验证的事实"
Uncertainties:
  - "不确定点（若无，写 '无'）"
Alternative_Paths:
  - "路径 A：优缺点"
Verification_Strategy: "如何验证本次改动"
```

要求：

- 假设必须显式写出，不能用“应该是”“大概是”代替确认。
- 非核心细节（命名、UI 微调）可以直接给出推荐方案和备选，不阻塞。
- Manifest 前允许为建立事实依据进行只读搜索和文件查看；输出 Manifest 后再进行代码编辑或运行会改变状态的命令。

---

## 3. 参考资料边界：`DeepSeek/` 不是本项目源码

`DeepSeek/` 目录是第三方参考开发资料，**不属于本项目的源代码**。

本项目真实源码与项目文档位于：

- `src/main/`
- `src/preload/`
- `src/renderer/`
- `src/shared/`
- `docs/`（不含 `DeepSeek/docs/`）
- 根目录 `package.json`、`electron.vite.config.ts`、`tsconfig.json`、`tsconfig.node.json`
- `openspec/`

严格规则：

- **不得**将 `DeepSeek/` 下的任何文件纳入构建、运行、测试、打包、发布流程。
- **不得**在 `package.json`、`tsconfig.json`、Vite / Electron / eslint / vitest / tailwind 等配置中引用 `DeepSeek/`。
- **不得**在改动本项目时修改 `DeepSeek/` 下的任何文件。
- **不得**在 `docs/agent-development.md` 或其他项目文档中把 `DeepSeek/` 列为依赖、来源或实现依据。
- 如需借鉴设计，必须在 `src/` 下独立实现，不得直接 import、link、copy 或 build `DeepSeek/` 下的任何文件。

本规则对人类协作者与 LLM Agent（包括本仓库内置 Agent 运行框架）一律生效；任何对 `DeepSeek/` 的写入、引入、引用都视为越界。

---

## 4. 当前项目实现概览

本仓库是 `agent-pyramid-desktop`：基于 Electron、Vite、React、TypeScript 的桌面 Agent Workbench。当前实现是“主进程运行时 + worker 隔离 LLM HTTP + preload 安全桥 + React 渲染端”的桌面应用。

真实运行链路：

```text
renderer React
  -> window.agentApi
  -> preload contextBridge
  -> ipcMain handlers
  -> AgentRuntime / stores / event bus
  -> LlmWorkerPool
  -> worker_threads
  -> MiniMaxGateway
  -> provider HTTP API
```

三层进程边界：

- `src/main/index.ts` 是主进程组合根，组装 `JsonlThreadStore`、`ModelConfigStore`、`RuntimeEventBus`、`LlmWorkerPool`、`AgentRuntime`、`InMemoryToolRegistry` 和全部 IPC handler。
- `src/main/infrastructure/llm-worker/` 使用 Node `worker_threads` 隔离 LLM 请求。`worker-pool.ts` 固定 `threadId -> worker` 路由，`worker.ts` 实例化 `MiniMaxGateway` 并把 SSE delta 转成 typed worker message。
- `src/preload/index.ts` 只暴露 `window.agentApi`，Electron 必须保持 `contextIsolation: true` 和 `nodeIntegration: false`。
- `src/renderer/src/` 是 React 19 UI，使用 `WorkbenchContext.tsx` 内的 `useReducer` 状态，不使用外部状态库。

---

## 5. 项目结构与职责边界

### 5.1 主进程分层

- `src/main/domain/agent/types.ts`：Agent 领域类型，包括 `AgentMessage`、`AgentToolDefinition`、`AgentToolCall`、`LlmRequest`、`LlmResponse`、`LlmStreamChunk`、`LlmGateway`、`AgentTool`。
- `src/main/domain/agent/ports.ts`：端口接口，目前包括 `ToolRegistry`。
- `src/main/application/agent-runtime.ts`：当前主运行时。负责多 turn 编排、线程历史收集、模型配置读取、worker 调用、流式 item 更新、工具调用、approval gate、中断和事件广播。
- `src/main/application/tools/`：工具注册与内置工具。`InMemoryToolRegistry` 是当前注册表，`echoTool` 是验证工具调用链路的内置工具。
- `src/main/infrastructure/minimax/`：LLM 网关实现。虽然目录名是 `minimax`，但 `MiniMaxGateway` 当前同时处理 MiniMax、DeepSeek、custom OpenAI-compatible 以及 Anthropic-compatible 请求。
- `src/main/infrastructure/llm-worker/`：worker 协议、worker 池、worker 入口。
- `src/main/ipc/`：主进程 IPC handler，按 `threads`、`turns`、`sse`、`approvals`、`write`、`model-config` 分文件注册。
- `src/main/persistence/`：Electron `userData` 下的线程 JSONL 持久化与模型配置持久化。
- `src/main/event-bus.ts`：运行时事件总线，按 `RuntimeEventKind` 和 `threadId` 订阅。

### 5.2 共享契约

- `src/shared/agent-contracts.ts` 是跨 main / preload / renderer 的权威类型来源，包含模型配置、thread、turn、item、runtime event、approval、write-mode、IPC envelope 与类型守卫。
- `src/shared/ipc.ts` 是 IPC channel 名称的权威来源，`RENDERER_TO_MAIN_CHANNELS` 是 renderer 可调用 channel 清单。
- `src/shared/locale.ts` 是支持语言的权威来源。

新增、删除或改名任何跨进程字段时，必须同步检查：

- `src/shared/agent-contracts.ts`
- `src/shared/ipc.ts`
- `src/main/ipc/*-handlers.ts`
- `src/preload/index.ts`
- `src/renderer/src/global.d.ts`
- `src/renderer/src/ui/**`

### 5.3 预加载层

`src/preload/index.ts` 通过 `contextBridge.exposeInMainWorld("agentApi", agentApi)` 暴露单一 API。当前分组包括：

- `threads.*`：list / create / get / update / delete / fork。
- `turns.*`：start / interrupt / get。
- `sse.*`：subscribe / unsubscribe / onEvent。
- `approvals.*`：respond。
- `goals.*`：update。
- `attachments.*`：create / get / delete。
- `usage.*`：daily。
- `write.*`：list / get / put / complete。
- `modelConfig.*`：get / update / listProfiles / createProfile / updateProfile / deleteProfile / activateProfile。

渲染端不得直接 import `src/main/`；只能通过 `window.agentApi` 或 `src/shared/` 交互。

### 5.4 渲染端

- `src/renderer/src/main.tsx` 挂载 `WorkbenchProvider + AppShell`，并在渲染前同步执行 `initTheme()`。
- `src/renderer/src/ui/AppShell.tsx` 根据 `WorkbenchContext` 的 `route` 懒加载 `Workbench` 或 `SettingsView`。
- `src/renderer/src/ui/Workbench.tsx` 是 code / write 工作台外壳，负责 thread 加载、SSE 订阅、发送消息、中断、approval 响应、路由到写作视图。
- `src/renderer/src/ui/store/WorkbenchContext.tsx` 是 renderer 状态中心，维护 `route`、`modelConfig`、`threads`、`activeThreadId`、`items`、`inFlightTurn`、composer、左右面板宽度和错误信息。
- `src/renderer/src/ui/components/chat/`：消息时间线和消息块。
- `src/renderer/src/ui/components/composer/`：浮动输入框。
- `src/renderer/src/ui/components/sidebar/`：线程侧栏。
- `src/renderer/src/ui/components/topbar/`：顶部栏。
- `src/renderer/src/ui/components/inspector/`：右侧检查器。
- `src/renderer/src/ui/components/write/`：写作模式 Markdown 文件列表与编辑视图。
- `src/renderer/src/ui/components/primitives/`：基础 UI 原语。
- `src/renderer/src/ui/styles/tokens.css` 与 `shell.css` 是当前样式入口；设计 token 使用 `--ds-*` 命名空间。
- `src/renderer/src/i18n/` 使用 `i18next` / `react-i18next`，当前语言为 `zh-CN` 和 `en`。

---

## 6. 当前运行时模型

### 6.1 单一运行路径

当前仓库只有一条 Agent 运行路径：

- 入口：`AgentRuntime`。
- UI 调用：`window.agentApi.turns.start()`、`turns.interrupt()`、`sse.subscribe()`。
- 数据模型：`ThreadRecord`、`TurnRecord`、`Item`、`RuntimeEvent`。
- 负责流式输出、JSONL 持久化、approval gate、工具调用和中断。

旧单次运行入口、旧 IPC channel 和旧响应 trace 契约已经下线。新增 Agent 能力必须接入多 turn runtime，不要恢复旧单次运行分支。

### 6.2 Turn 生命周期

主路径的大致流程：

1. Renderer 调用 `turns.start({ threadId, text, model, reasoningEffort })`。
2. `AgentRuntime.startTurn()` 检查 thread 是否存在，并阻止同 thread 并发 in-flight turn。
3. Runtime 先追加 `UserItem` 到 `JsonlThreadStore`，再 emit `item_appended` 和 `turn_started`。
4. Runtime 从 `ModelConfigStore` 读取当前激活模型配置，收集 thread 历史，组装 `LlmRequest`。
5. `LlmWorkerPool.chat()` 把请求交给 worker，worker 通过 `MiniMaxGateway.stream()` 读取 SSE。
6. `text_delta` / `reasoning_delta` 在 runtime 内形成 live `AssistantItem` / `ReasoningItem`，通过 `item_updated` 推给 renderer。
7. 流结束后，最终 item 写入 JSONL，并 emit `item_appended`。
8. 如模型返回工具调用，runtime 为每个工具创建 `ToolItem`；`create_plan` 只在 plan mode 暴露并免 approval，`update_goal` 只在 goal mode 或 active goal thread 暴露并免 approval，其它工具调用请求 approval。
9. 工具执行完成或失败后更新 `ToolItem` 结果并 emit `item_updated`，最后 emit `turn_completed`。

中断流程：

- Renderer 调用 `turns.interrupt(turnId, { force: true })`。
- Runtime 调用 `pool.cancel(threadId)`，worker 通过 `AbortController` 终止 HTTP stream。
- Runtime 追加 warning `SystemItem`，并把 turn 标记为 `interrupted`。

### 6.3 工具机制

- 工具契约是 `AgentTool`。
- 工具定义通过 `ToolRegistry.listDefinitions()` 提供给模型。
- 工具执行通过 `ToolRegistry.execute(call)` 返回 `AgentToolResult`。
- 新工具应放在 `src/main/application/tools/` 或更合适的 application 子目录，并在 `src/main/index.ts` 的 `InMemoryToolRegistry([...])` 组合处注册。
- 当前内置工具包括 `echoTool`、`createPlanTool` 和 `createGoalTools()` 返回的 `update_goal`。
- 当前 approval gate 对除模式门控内的 `create_plan` / `update_goal` 外的工具调用生效；修改工具策略时必须同步 `AgentRuntime.listToolDefinitionsForTurn()`、`AgentRuntime.requiresApproval()`、UI 和持久化记录。

---

## 7. LLM 接入现状

`src/main/infrastructure/minimax/minimax-gateway.ts` 中的 `MiniMaxGateway` 实现 `LlmGateway`：

- `complete(request)`：非流式完整响应。
- `stream(request, options)`：流式 SSE 响应，yield `LlmStreamChunk`。

协议分流：

- `request.protocol === "openai-compatible"`：走 chat completions 形态。
- `request.protocol === "anthropic-compatible"`：走 messages 形态。

Provider 方言分流：

- `MiniMax`：使用 `/v1/chat/completions`，请求体包含 `max_completion_tokens`、`reasoning_split`、`thinking.type=adaptive|disabled`。
- `DeepSeek`：使用 `/chat/completions`，请求体包含 `max_tokens`、`thinking.type=enabled|disabled`、`reasoning_effort=high|max`。
- 其他 provider：走 custom OpenAI-compatible 请求体。

模型配置：

- 默认配置在 `DEFAULT_MODEL_CONFIG`。
- DeepSeek 默认配置在 `DEFAULT_DEEPSEEK_MODEL_CONFIG`。
- 配置持久化由 `ModelConfigStore` 写入 Electron `userData/config`。
- 运行时每个 turn 读取当前激活 profile。
- API key 优先使用配置中的 `OPENAI_API_KEY`；为空时按 provider fallback 到 `DEEPSEEK_API_KEY`、`MINIMAX_API_KEY`，最后 fallback 到 `OPENAI_API_KEY` 环境变量。
- 不得在代码、文档、测试或提交中写入真实 API key。

`docs/minimax/` 是本地协议资料，只能作为接口依据。不得把其中内容 import 到运行时代码，也不得把它加入构建链路。

---

## 8. 持久化布局

线程数据由 `JsonlThreadStore` 写入 Electron `userData/threads/`：

```text
threads/
  index.json
  <threadId>/
    thread.json
    messages.jsonl
    events.jsonl
```

行为约束：

- `index.json` 保存 `ThreadSummary[]`。
- `thread.json` 保存 `ThreadRecord`。
- `messages.jsonl` 每行一个 `Item`。
- `events.jsonl` 每行一个 `RuntimeEvent`。
- 同 thread 写入通过 per-thread mutex 串行化。
- JSON 写入使用临时文件 + fsync + rename。
- JSONL append 使用 fsync。
- replay 使用 `readline`，遇到 malformed line 会 `console.warn` 后跳过。不要在没有迁移方案的情况下改成直接失败。

模型配置由 `ModelConfigStore` 写入 Electron `userData/config`：

- 当前格式是 `ModelConfigProfilesState`。
- 旧单配置会被 normalize 为 profiles 状态。
- 至少保留一个 profile。
- `ModelConfigStore.get()` 只返回当前激活 profile 的 `ModelConfig`，不要让 runtime 直接感知设置页 UI 结构。

---

## 9. IPC 与事件规范

所有 IPC 必须使用 `IpcResult<T>` envelope：

- 成功：`ok(value)`。
- 失败：`err(code, message)`。

新增 IPC 的完整步骤：

1. 在 `src/shared/agent-contracts.ts` 定义 request / response 类型。
2. 在 `src/shared/ipc.ts` 定义 channel 常量，并加入 `RENDERER_TO_MAIN_CHANNELS`。
3. 在 `src/main/ipc/` 增加或更新 handler，所有异常必须返回可追踪 `err(code, message)`。
4. 在 `src/main/index.ts` 注册 handler。
5. 在 `src/preload/index.ts` 暴露最小必要 API。
6. 在 `src/renderer/src/global.d.ts` 和 renderer 调用处同步类型。
7. 搜索所有 channel 名、类型名、字段名，确认调用方完整更新。

运行时事件：

- 事件类型定义在 `RuntimeEvent`。
- `RuntimeEventBus` 负责主进程内订阅。
- `sse-handlers.ts` 通过 `webContents.send(SSE_PUSH_CHANNEL, evt)` 推送到 renderer。
- Renderer 通过 `window.agentApi.sse.onEvent()` 监听。
- 新事件必须同步 `RuntimeEventKind`、`RuntimeEventBus.onThread()` 订阅列表和 renderer 消费逻辑。

---

## 10. UI 与 i18n 规则

UI 改动必须遵守 `docs/ui-design.md` 和当前 CSS token 体系。

- 优先使用 `tokens.css` 中的 `--ds-*` 变量，不新增散落 hex 色值。
- 不引入 Tailwind、Zustand、React Router 或新的 UI 框架，除非用户明确要求并完成方案确认。
- 现有路由由 `WorkbenchContext.state.route` 表示：`code | write | settings`。
- 现有主题通过 `agent.theme` localStorage 和 `<html data-theme>` 控制。
- 新增文案必须同时更新 `src/renderer/src/i18n/locales/zh-CN/translation.json` 和 `src/renderer/src/i18n/locales/en/translation.json`。
- 新增语言必须同步更新 `src/shared/locale.ts`。
- 渲染端错误不能静默吞掉，至少写入 UI state 或返回可见错误信息。

---

## 11. 执行原则

### 11.1 只实现被要求的内容

只做用户明确要求的事。一个改动只覆盖一个职责边界。

- 能用现有库、标准库或项目内工具解决的，不引入新依赖；如必须新增，说明理由。
- 如果仓库里已有同类实现，沿用它的结构和模式。
- 不为单一调用创建抽象层，不添加“未来预留”。
- 应可配置的规则、阈值、关系，优先使用配置文件、环境变量或常量承载，不写死在逻辑中。

### 11.2 先读后改

动手前先确认现有定义、调用链、邻近实现和测试分布。

- 新增或变更字段、接口、状态、枚举、路径或返回值时，同步检查所有调用方、类型定义和测试是否需要一起更新。
- 同一个业务概念只允许有一个权威来源，不散落为多个字面量。
- 状态码、节点名、阈值等多处引用的值，提取为常量、枚举或配置项。
- 优先使用 `rg` / `rg --files` 搜索。搜索范围默认排除 `DeepSeek/`，除非任务明确要求只读参考。

### 11.3 新旧逻辑划界

新增逻辑与旧逻辑不能无边界混合。先决定是 **彻底替换** 还是 **隔离共存**。

- 替换：旧逻辑确认无调用后清理干净。
- 共存：在入口层做明确分流，不在底层到处写 `if-else`。
- 保留的旧逻辑必须标注弃用原因和下线条件。
- 数据结构变更优先单向迁移，不在读取端兼容所有历史格式。

当前必须特别注意：

- `AgentRuntime` 是主路径。
- 旧单次运行入口已删除，不要重新引入兼容壳或旧编排器。

### 11.4 可验证地完成

任何模糊指令必须转成可验证目标。

- “添加功能” -> 可执行的验收步骤。
- “修复 bug” -> 先复现，再修复，再验证。
- “重构” -> 前后可观测行为一致。

当前未配置测试框架。每次代码改动至少运行：

```bash
npm run typecheck
npm run build
```

如果改动不涉及代码（例如只改文档），至少检查文档内容可读、引用路径存在，并说明未运行构建的原因。

### 11.5 清理副产物

完成后清理本次改动产生的废弃导入、无用变量、孤儿结构、失效配置。若必须使用 stub 或临时数据，显式标记用途和移除条件。

禁止使用：

- `any`
- `// @ts-ignore`
- 静默 `catch {}`
- 无错误码的失败返回
- 硬编码真实密钥

---

## 12. 构建、测试与开发命令

- `npm install`：首次克隆后安装依赖。
- `npm run dev`：启动 Electron + Vite renderer 开发环境。
- `npm run build`：构建 main、preload、renderer 到 `out/`。
- `npm run typecheck`：运行 renderer 与 node tsconfig 的 TypeScript 类型检查。
- `npm run preview`：预览构建后的 Electron 应用。

如果 Electron 下载失败，可使用镜像：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npx install-electron --no
```

当前没有 test runner、linter、formatter 配置。不要在未确认的情况下新增这些工具。

---

## 13. 编码风格与命名约定

- 使用严格 TypeScript。
- 缩进使用两个空格。
- 字符串使用双引号。
- React 组件和类使用 `PascalCase`。
- 函数与变量使用 `camelCase`。
- 常量仅在真正跨模块固定值时使用 `UPPER_SNAKE_CASE`。
- 主进程相对导入当前多使用 `.js` 后缀以匹配 ESM 输出；新增 main/preload 导入时沿用邻近文件风格。
- Renderer 组件导入沿用当前无 `.js` 后缀风格。
- 只在复杂逻辑前添加有价值的注释，不写解释变量赋值的空注释。

---

## 14. 文档同步要求

Agent 开发维护文档位于 `docs/agent-development.md`。

凡是修改以下能力，必须同步更新该文档：

- Agent 运行框架。
- LLM 接入。
- 工具机制。
- IPC 契约。
- 持久化格式。
- 桌面 UI。
- 国际化能力。
- 模型配置。
- worker 运行方式。

UI 设计规则位于 `docs/ui-design.md`。修改设计 token、布局语法、主题、组件模式时必须同步更新。

涉及 OpenSpec change 时，优先检查 `openspec/changes/` 下对应 change 的 `proposal.md`、`design.md`、`tasks.md` 和 `specs/`。

---

## 15. 提交与 Pull Request

提交信息建议使用 Conventional Commits，例如：

- `feat: add minimax gateway`
- `fix: validate max tokens`
- `docs: update agent guide`

PR 需说明：

- 变更目的。
- 影响模块。
- 验证命令。
- 涉及 UI 时附截图。
- 涉及接口或协议时注明依据的 `docs/minimax/` 文档。
- 涉及 Agent 框架能力时说明是否已更新 `docs/agent-development.md`；如无需更新，写明原因。

---

## 16. 安全与配置

- 不提交 API Key、密钥或本地敏感配置。
- MiniMax / DeepSeek / OpenAI-compatible 凭据只允许通过运行时输入、模型配置或环境变量提供。
- 保持 Electron 安全设置：`contextIsolation: true`、`nodeIntegration: false`。
- 文件写入能力必须做路径边界检查；`write-handlers.ts` 当前使用 `resolveSafe()` 防止 path escape。
- 不扩大 preload 暴露面，除非有明确业务需求和类型契约。
- 不把 renderer 变成 Node 环境，不在 renderer 直接访问文件系统。

---

## 17. 生成后自查清单

每次生成或修改代码后，必须逐条检查：

- [ ] 本次改动是否只涉及与任务直接相关的文件？
- [ ] 所有新引用的函数/类型/字段是否已确认存在于仓库中？
- [ ] 是否引入了新的第三方依赖？如果是，现有方案为什么不够？
- [ ] 新增代码的异常路径是否有处理？错误是否可追踪？
- [ ] 是否留下了未清理的废弃代码或临时产物？
- [ ] 如果涉及接口/类型变更，所有调用方和测试是否已同步更新？
- [ ] 如果涉及 Agent、LLM、工具、IPC、持久化、UI 或 i18n，是否已同步更新 `docs/agent-development.md`？
- [ ] 是否避免了对 `DeepSeek/` 的写入、构建引用和文档依赖表述？

---

## 18. 规则优先级

当规则之间存在张力时，按以下顺序裁决：

1. **正确性**：不引入幻觉引用，不吞掉错误。
2. **安全性**：最小变更范围，不污染相邻模块。
3. **可验证性**：先确认再执行，改动可被验证。
4. **可维护性**：简洁实现，复用现有模式。

如果“只打补丁会让代码明显变丑、变脆、变难测”，先向用户提交 **Refactor vs Patch** 对比方案，再决定是否进行小范围重构。

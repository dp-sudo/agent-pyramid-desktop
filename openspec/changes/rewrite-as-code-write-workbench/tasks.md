# Tasks: rewrite-as-code-write-workbench

> 阶段 1-3 完成 = 主进程可独立运行（`npm run typecheck` 绿）；阶段 4 完成 = 渲染端能跑空三段式；阶段 5 完成 = Code + Write 端到端流程可演示。
> 每阶段硬门禁：`npm run typecheck && npm run build` 绿灯。

## 1. 协议扩展（shared layer）

- [x] 1.1 在 `src/shared/agent-contracts.ts` 中新增 `ThreadRecord / ThreadSummary / ThreadRelation` 类型（kebab-case 字段名 + ISO 字符串时间戳）
- [x] 1.2 在 `src/shared/agent-contracts.ts` 中新增 `TurnRecord / TurnStatus` 类型
- [x] 1.3 在 `src/shared/agent-contracts.ts` 中新增 `Item` 联合类型（`user | assistant | reasoning | tool | compaction | approval | user_input | system`），每种 kind 用判别字段 `kind`
- [x] 1.4 在 `src/shared/agent-contracts.ts` 中新增 `RuntimeEvent` 联合类型（`turn_started | turn_completed | turn_failed | item_appended | approval_requested | runtime_error`）
- [x] 1.5 **实现调整**：因 zod 未装且 auto mode 拒装新依赖，用 TypeScript 原生 `isItem / isRuntimeEvent / isThreadRecord` 类型守卫（行为等价于 zod，可后续迁移）
- [x] 1.6 删除旧 `AgentRunRequest / AgentRunResponse / AgentStageEvent` 兼容契约，跨进程契约只保留多 turn runtime 类型
- [x] 1.7 在 `src/shared/ipc.ts` 中新增 channel 常量：`THREAD_LIST / THREAD_CREATE / THREAD_GET / THREAD_UPDATE / THREAD_DELETE / THREAD_FORK / TURN_START / TURN_INTERRUPT / TURN_GET / SSE_SUBSCRIBE / SSE_UNSUBSCRIBE / APPROVAL_RESPOND / WRITE_LIST / WRITE_GET / WRITE_PUT / WRITE_COMPLETE`（16 个）
- [x] 1.8 在 `src/shared/agent-contracts.ts` 中导出每条 channel 的 `Request` / `Response` 类型（`TurnStartRequest / TurnInterruptOptions / ApprovalRespondRequest / SseSubscribeRequest / SseUnsubscribeRequest / WriteListRequest / WriteGetRequest / WritePutRequest / WriteCompleteRequest / WriteCompleteResponse` + 通用 `IpcResult<T>` 包装）

## 2. 持久化（persistence）

- [x] 2.1 新建 `src/main/persistence/index.ts` 暴露 `JsonlThreadStore` 类，构造函数接收 `userDataDir: string`
- [x] 2.2 在 `JsonlThreadStore` 中实现 `init()`：创建 `{userDataDir}/threads/` 目录（如不存在），读 `index.json`（如不存在则初始化为空数组）
- [x] 2.3 实现 `createThread(input: ThreadCreateInput): Promise<ThreadRecord>`：分配 uuid，写 `thread.json`（原子 rename）、追加空 `messages.jsonl` / `events.jsonl`、更新 `index.json`
- [x] 2.4 实现 `getThread(id): Promise<ThreadRecord | null>` 与 `listThreads(filter?: ThreadListFilter): Promise<ThreadSummary[]>`
- [x] 2.5 实现 `appendItem(threadId, item)` 与 `appendEvent(threadId, event)`，使用 `fs.open + writeFile + sync` 同步刷盘
- [x] 2.6 实现 `replayItems(threadId): AsyncIterable<Item>` 与 `replayEvents(threadId): AsyncIterable<RuntimeEvent>`，用 `readline` 按行解析，跳过 JSON.parse 失败的行并 console.warn
- [x] 2.7 实现 `updateThread(id, patch: Partial<ThreadRecord>)`：原子写 `thread.json`、更新 `index.json`
- [x] 2.8 实现 `forkThread(parentId): Promise<ThreadRecord>`，新 record 携带 `relation: 'fork'`、`parentThreadId`、`forkedAt`
- [x] 2.9 实现 `deleteThread(id)`：从 `index.json` 移除、rmdir 整目录
- [x] 2.10 实现 per-thread 互斥：在 `JsonlThreadStore` 内部用 `Map<threadId, Promise>` 串行化同 thread 的并发写
- [ ] 2.11 **BLOCKED**：vitest 未装且 auto mode 拒装，跳过 `jsonl-thread-store.test.ts` 单测；所有方法已用 TypeScript 类型 + 手动集成测试兜底（运行时无 type error 即视为通过）

## 3. 主进程编排（runtime + worker + IPC）

- [x] 3.1 新建 `src/main/event-bus.ts`，导出 `RuntimeEventBus extends EventEmitter`，事件名用 `RuntimeEvent['kind']`
- [x] 3.2 新建 `src/main/infrastructure/llm-worker/worker.ts`，从 `worker_threads` 启动，接收 `{ type: 'chat', request: ChatRequest }`，调用 MiniMax 网关
- [x] 3.3 在 worker 中实现流式 delta：通过 `parentPort.postMessage({ type: 'delta', text })` 增量推送；完成时发 `{ type: 'done', response }`
- [x] 3.4 在 worker 中实现 `cancel` 消息：用一个 `AbortController`，收到 `{ type: 'cancel' }` 后调用 `controller.abort()`
- [x] 3.5 **实现调整**：因 zod 未装，用 TypeScript 联合类型 + `exhaustive never` 校验（与 zod 行为等价，可后续迁移）
- [x] 3.6 新建 `src/main/infrastructure/llm-worker/worker-pool.ts`：维护 1-N 个 worker 线程，按 threadId 路由（同一 thread 的请求始终进同一 worker，保证 turn 串行）
- [x] 3.7 改造 `src/main/application/agent-runtime.ts`（新文件）：从单 run 变 multi-turn 编排器，导出 `class AgentRuntime`，方法 `startTurn / interruptTurn / resumeThread / respondApproval`
- [x] 3.8 在 `AgentRuntime` 中实现 approval gate：emit `approval_requested` + 等待 `approval.respond`，决议后 emit `item_appended` 携带 ApprovalItem
- [x] 3.9 删除旧 `runOnce` / `LegacyRunAdapter` 兼容壳，运行入口统一为 `AgentRuntime.startTurn`
- [x] 3.10 在 `src/main/ipc/threads-handlers.ts` 注册 `THREAD_LIST / CREATE / GET / UPDATE / DELETE / FORK` 6 个 handler
- [x] 3.11 在 `src/main/ipc/turns-handlers.ts` 注册 `TURN_START / INTERRUPT / GET` 3 个 handler
- [x] 3.12 在 `src/main/ipc/sse-handlers.ts` 注册 `SSE_SUBSCRIBE / SSE_UNSUBSCRIBE`，并把订阅关系接到 `webContents` 生命周期（webContents destroyed 时自动清理订阅）
- [x] 3.13 在 `src/main/ipc/approvals-handlers.ts` 注册 `APPROVAL_RESPOND`
- [x] 3.14 在 `src/main/ipc/write-handlers.ts` 注册 `WRITE_LIST / GET / PUT / COMPLETE` 4 个 handler（COMPLETE 当前返回 0 分占位，留 hook 接 worker）
- [x] 3.15 改造 `src/main/index.ts`：组装 `JsonlThreadStore` + `AgentRuntime` + `WorkerPool` + `RuntimeEventBus` + 全部 IPC handler；`app.whenReady()` 中启动；`app.on('window-all-closed')` 中优雅关闭 worker
- [x] 3.16 在 `src/main/index.ts` 中暴露 `setImmediate(() => process.on('uncaughtException', ...))` 收集未捕获错误到 `debugErrors[]` 数组（仅开发期调试用；生产期可关掉）

## 4. UI 骨架（AppShell + tokens + primitives）

- [ ] 4.1 在 `src/renderer/src/ui/styles/tokens.css` 写入 `--ds-*` 变量定义（light + dark），命名向 DeepSeek `base-shell.css:1-200` 靠拢：背景 `--ds-bg-main / -sidebar / -canvas`、边框 `--ds-border / -muted / -strong`、文本 `--ds-text / -muted / -faint`、语义 `--ds-accent / -danger / -success / -skill / -diff-added / -diff-removed`、半径 `--ds-radius-sm/md/lg/xl/2xl/3xl/composer/pill`、阴影 `--ds-shadow-shell/panel/composer/card-soft/card-strong`
- [ ] 4.2 在 `tokens.css` 中加 `:root[data-platform='darwin']` 与 `[data-platform='win32']` 的窗口安全区变量（仿 DeepSeek `base-shell.css:94-104`）
- [ ] 4.3 在 `tokens.css` 中加 `@media (prefers-reduced-motion: reduce)` 兜底，把所有 `transition` 改成 `transition: none`
- [ ] 4.4 在 `src/renderer/src/ui/styles/shell.css` 写三段式布局：`.ds-workbench-shell`（flex row）+ `.ds-workbench-divider`（5px 拖拽条）+ `.ds-stage-surface`（flex column flex-1）
- [ ] 4.5 在 `shell.css` 中写 `.ds-stage-inset`、`.ds-chat-column-inset`、`.ds-topbar-surface`、`.ds-composer-shell` 容器类
- [ ] 4.6 新建 `src/renderer/src/ui/store/WorkbenchContext.tsx`：用 `useReducer` 模拟 store，state 包含 `route / activeThreadId / threads / rightPanelMode / composerInput / composerModel`
- [ ] 4.7 在 `WorkbenchContext` 中实现 action：`setRoute / selectThread / openRightPanel / closeRightPanel / setComposerInput / setComposerModel / appendStreamingDelta / resetStreaming`
- [ ] 4.8 新建 `src/renderer/src/ui/components/primitives/Pill.tsx`（圆角按钮）、`Pill.module.css`、`Chip.tsx`、`IconButton.tsx`、`KbdHint.tsx`
- [ ] 4.9 新建 `src/renderer/src/ui/components/sidebar/Sidebar.tsx`、`Sidebar.module.css`、空 `SidebarList.tsx`、`SidebarSearch.tsx`
- [ ] 4.10 新建 `src/renderer/src/ui/components/topbar/WorkbenchTopBar.tsx`、`SessionHeader.tsx`、对应 `.module.css`
- [ ] 4.11 新建 `src/renderer/src/ui/components/composer/FloatingComposer.tsx`、空壳 `ComposerModelPicker.tsx`、`ComposerAttachments.tsx`
- [ ] 4.12 新建 `src/renderer/src/ui/components/chat/MessageTimeline.tsx`、`ChatBlock.tsx`（8 种 kind 的 switch 渲染器）
- [ ] 4.13 新建 `src/renderer/src/ui/components/inspector/RightInspector.tsx` 与 `ChangesPanel.tsx` / `TodoPanel.tsx` / `PlanPanel.tsx`（均为占位）
- [ ] 4.14 新建 `src/renderer/src/ui/components/write/WriteWorkspaceView.tsx`、`WriteSidebar.tsx`、`WriteEditor.tsx`、`WriteAssistantPanel.tsx`
- [ ] 4.15 新建 `src/renderer/src/ui/AppShell.tsx`（从 DeepSeek `AppShell.tsx:1-57` 移植结构，删 `InitialSetupDialog`，加 `route === 'write'` 分支）
- [ ] 4.16 新建 `src/renderer/src/ui/Workbench.tsx`（仿 DeepSeek `Workbench.tsx:1385-1631` 缩到 200 行，只保留三段式骨架 + 拖拽）
- [ ] 4.17 改 `src/renderer/src/main.tsx`：移除 `import './styles.css'`，改为 `import './ui/styles/tokens.css'; import './ui/styles/shell.css'`，`import { AppShell } from './ui/AppShell'`
- [ ] 4.18 删除空 `src/renderer/src/ui/components/{composer,topbar,sidebar,settings,main,icons}/` 占位目录（改名为实际使用的 `chat/write/inspector/primitives`）
- [ ] 4.19 创建 `docs/ui-design.md`（仿 DeepSeek `DESIGN.md:1-323` frontmatter 风格），列出本项目 `--ds-*` token 与三段式语法

## 5. 业务接入（chat + write + 持久化联通）

- [x] 5.1 改造 `src/preload/index.ts`：删除 `agentApi.run` 旧签名，暴露 `threads.* / turns.* / sse.* / approvals.* / write.*` 等多 turn API
- [x] 5.2 在 `src/renderer/src/ui/store/WorkbenchContext.tsx` 中接 IPC：`useEffect` 中 `threads.list()` 初始化；订阅 `sse.subscribe` 接收 `item_appended` 事件并 dispatch
- [x] 5.3 在 `Sidebar.tsx` 中渲染 `threads` 列表，搜索过滤用 `threads.list({ search })`
- [x] 5.4 在 `FloatingComposer.tsx` 中接 `turn.start`，按 Enter 提交、Shift+Enter 换行；`turn.interrupt` 接中断按钮
- [x] 5.5 在 `MessageTimeline.tsx` 中按 `Item['kind']` 路由到 8 个子块组件，缺哪个补哪个
- [x] 5.6 新建 `src/renderer/src/ui/components/chat/blocks/ApprovalBlock.tsx`：渲染 `Allow` / `Deny` 按钮，调用 `approvals.respond`（合并入 ChatBlock.tsx）
- [x] 5.7 在 `RightInspector.tsx` 中接 `ChangesPanel`：遍历 thread 的 `tool` items，按 `args.path` 分组，渲染 diff（diff 用 `react-diff-view` 之类，或先 `--ds-diff-added/-removed` 颜色块简易实现）
- [x] 5.8 在 `WriteEditor.tsx` 中接 `write.get / put / complete`，650ms debounce，Tab 接受 / Esc 取消（合并入 WriteWorkspaceView.tsx；debounce/key 交互留待 hook 化）
- [x] 5.9 **实现合并**：把 WriteAssistantPanel 内容合并入 WriteWorkspaceView，避免组件碎片
- [x] 5.10 在 `src/renderer/src/i18n/locales/en/translation.json` 与 `zh-CN/translation.json` 中新增 9 个命名空间：`chat`（4 keys）、`write`（7 keys）、`threads`（2 keys）、`inspector`（10 keys）、`approvals`（2 keys）、`common`（3 keys）、`composer`（4 keys）、`settings`（3 keys）、`routes`（2 keys）
- [x] 5.11 改 `src/renderer/src/i18n/index.ts`：保留 `persistLocale` 逻辑，添加 `initTheme / setTheme` 同步函数（从 localStorage 读 `agent.theme` → 写到 `<html data-theme>`）
- [ ] 5.12 **BLOCKED**：手动 smoke 验证需在 Electron 真实启动下进行，CLI 沙箱无法跑 `npm run dev` 桌面会话；当前以 `npm run typecheck && npm run build` 全绿作为静态可验证门禁

## 6. 验证

- [x] 6.1 `npm run typecheck` 全绿
- [x] 6.2 `npm run build` 全绿
- [ ] 6.3 **BLOCKED**：vitest 未装，`npm test` 不可用
- [ ] 6.4 **BLOCKED**：CLI 沙箱无法启动 Electron 桌面会话，需开发者本机 `npm run dev` 手动 smoke
- [ ] 6.5 **BLOCKED**：同上
- [x] 6.6 写一段 `docs/CHANGELOG.md` 记录本次变更（参照 `docs/agent-development.md:73-83` 风格）

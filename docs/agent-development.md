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
- 建立首批 coding agent 写入工具：`read_file` 会记录文件读状态，`read_file` / `search_files` 都严格校验 UTF-8 文本；`edit_file` / `write_file` 使用共享 workspace 路径策略、读后未过期校验和结构化 diff preview，经 approval gate 后写入工作区文本文件；`apply_patch` 支持受限 unified diff dry-run、多文件 diff preview、`No newline at end of file` 语义保留和一次性提交；`rollback_file` 可回滚当前 app 会话内最近一次 agent 文件写入。
- 建立开发命令工具组：`run_command`、可配置 `shell_command`、`git_bash_command`、`powershell_command`、`wsl_command`、`rg_search`、结构化 Git 工具、npm/pnpm/yarn/bun 包管理器包装器、通用 lint/format/test/build 包装器、长驻 command session 和 shell 环境探测都通过 `createCommandTools()` 独立注册。
- 建立首批诊断工具：`diagnose_workspace` 在 active workspace 内运行 TypeScript/typecheck 并解析结构化错误；`diagnose_file` 使用 TypeScript Language Service 对单文件做语法/语义/建议诊断，用于编辑后的 workspace 级与文件级验证闭环。
- 建立 Code/Write tool access 边界：`AgentRuntime` 默认在 Write threads 中隐藏并拒绝 Code-only 编码/命令工具，同时保留可注入的 per-mode tool access policy 以便单独允许或禁用指定工具。
- 建立 MiniMax、DeepSeek、自定义 OpenAI-compatible 的供应商感知协议适配：`src/main/infrastructure/minimax/`。
- 建立大模型多配置档案：`src/shared/agent-contracts.ts`、`src/main/persistence/model-config-store.ts`、`src/main/ipc/model-config-handlers.ts`、`src/preload/index.ts`、`src/renderer/src/ui/SettingsView.tsx`，配置保存到 Electron `userData/config` 文件。
- 建立 React 桌面控制台 UI：`src/renderer/src/ui/`。
- 修复多会话运行投影：renderer 以 `inFlightTurnsByThreadId` 追踪每个 thread 的运行中 turn，SSE 支持同一窗口多 thread 订阅；切换会话不再丢失后台完成、失败或审批事件，当前 thread 的未决审批会在 composer 上方显示即时处理面板。
- 修复 `turn_started` 状态投影：事件携带 runtime 创建的完整 `TurnRecord`，renderer 不再用当前 composer/model 状态推断后台 turn 的模型、profile 或模式。
- 清理 Write 模式 IPC 契约：`WritePutRequest` 只保留当前已实现的 plain UTF-8 写入字段，删除未接入 handler 的 `viaGit` 旧字段，避免调用方误以为 `write.put` 会走 git apply。
- 修复设置页模型档案状态机：profile 保存失败后如果表单仍与 active profile 不一致，切换 section/profile、复制、删除或返回工作台会继续触发未保存修改守卫，避免把失败后的用户修改静默丢弃。
- 修复 SSE IPC envelope 边界：`sse:subscribe` / `sse:unsubscribe` 对坏请求返回 `SSE_SUBSCRIBE_FAILED` / `SSE_UNSUBSCRIBE_FAILED`，不再让 ipcMain handler 直接 throw。
- 设置页采用六个一级设置区 + 左侧区内小类导航：基础设置承载外观与语言，大模型设置承载模型档案、连接信息、上下文和推理行为，Agent 行为承载上下文压缩，工具与权限承载默认审批/沙盒、工具目录和命令限制，工作台设置承载启动/布局/会话和 Code/Write 默认模型，通知与可见性承载 approval 展示偏好。
- 打磨前端可用性与可访问性：设置页左侧导航支持当前大类内搜索，设置表单的 `input/select` 通过 `SettingRow` 建立真实 label 关联，模型 profile 脏表单和 Write 工作台脏文档会在窗口刷新/关闭前触发未保存提示；Composer 附件处理新增 pending 反馈并阻止处理中发送，模型选择器补充空态；Write 工作台搜索改为短防抖，减少高频 IPC 抖动。
- 建立中英文国际化资源和语言切换能力：`src/renderer/src/i18n/`、`src/shared/locale.ts`。
- 建立 Vitest 自动化测试体系：`vitest.config.ts`、`tsconfig.test.json`、`tests/`，覆盖共享契约、主进程持久化、模型配置、附件、工具、事件总线、LLM 网关、AgentRuntime 和渲染端 reducer。

## 架构决策

1. 领域层不依赖 MiniMax、Electron、React 或 HTTP 响应结构。
2. LLM 接入统一通过 `LlmGateway`，供应商协议差异只存在于 `infrastructure`。
3. Agent 编排器只处理运行流程，不直接拼接供应商请求体。
4. 工具能力通过 `ToolRegistry` 接口注册、预览和执行，后续工具不得绕过注册机制；runtime 先按 thread mode 与可配置 tool access policy 决定工具是否进入当前 turn catalog，再基于 metadata、`approvalPolicy` 与 `sandboxMode` 做审批/拒绝决策。
5. 渲染层只通过 preload 暴露的安全 API 调用主进程，不直接访问 Node 能力。
6. 界面语言和主题切换属于渲染层展示机制，语言资源集中维护在 `src/renderer/src/i18n/`，可支持语言由 `src/shared/locale.ts` 统一定义；设置页“基础设置”直接调用渲染层 localStorage 偏好，不进入主进程运行时配置。会影响 Agent runtime、工具目录、命令限制、上下文压缩或新线程安全默认值的设置必须进入 shared `RuntimePreferences`、main-process persistence 和 typed IPC。
7. 大模型运行时仍以 `src/shared/agent-contracts.ts` 中的 `ModelConfig` 作为当前激活配置契约；持久层在外层维护 `ModelConfigProfilesState`（`activeProfileId + profiles[]`），`ModelConfigStore.get()` 只返回当前激活档案的 `ModelConfig`，避免 Agent 运行循环感知多档案 UI。
8. LLM 网关按 `ModelConfig.model_provide` 做供应商感知请求体分流：`MiniMax` 使用 `max_completion_tokens/reasoning_split/thinking.type=adaptive|disabled`，`DeepSeek` 使用 `/chat/completions`、`max_tokens/thinking.type=enabled|disabled/reasoning_effort=high|max`，其他供应商走通用 OpenAI-compatible 请求体。
   `AgentRuntime` now forwards the selected model profile `protocol` into `LlmRequest`; OpenAI-compatible and Anthropic-compatible profiles share the same runtime path while the gateway owns provider-specific body/SSE mapping.
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

### 2026-06-11 - Command tool hardening follow-up
- Hardened `rollback_file` so in-memory file history can only be rolled back by the same thread that created the latest history entry, preventing same-workspace cross-thread rollback of another session's write.
- Preserved interrupted `ToolItem` results when a pending approval is auto-denied during turn interruption, so replay keeps the interrupt reason instead of rewriting it as a normal denial.
- Hardened command sessions so `read_command_session`, `write_command_session`, and `stop_command_session` only operate from the same thread and workspace that created the session.
- Made `write_command_session` preserve input exactly, wait for stdin to accept it, and return the actual UTF-8 byte count, with closed stdin and async write failures surfaced as tool errors instead of best-effort success.
- Made `stop_command_session` wait for the process to reach a terminal state before returning, preventing stopped sessions from leaving the workspace directory busy during cleanup or follow-up tool calls.
- Preserved `failed` command session status after spawn/runtime errors so a later child `close` event cannot rewrite the session as a normal exit and hide the captured error.
- Hardened Windows foreground command cancellation so timeout/interrupt falls back to direct child termination when `taskkill /T /F` starts but exits unsuccessfully.
- Changed Git pathspec validation from realpath read checks to the shared workspace lexical policy, allowing deleted tracked files to be diffed or staged while still rejecting hidden, path-escaping, magic, and glob pathspecs.
- Tightened `git_log.ref` so the structured read-only log tool accepts revision/range values but rejects Git options, pathspec magic, whitespace/control characters, and NUL bytes before invoking Git.
- Tightened model-provided package script overrides so package/task wrappers accept script identifiers such as `format:write` but reject package-manager options, whitespace/control characters, NUL bytes, and unsupported shell metacharacters before spawning npm/pnpm/yarn/bun.
- Tightened npm `package_install` frozen lockfile mode so it uses `npm ci` only with `package-lock.json` or `npm-shrinkwrap.json`, and fails instead of silently falling back to `npm install` when no npm lockfile exists.
- Rejected symbolic-link components in destructive coding tool targets so `edit_file`, `write_file`, `delete_file`, `apply_patch`, and `rollback_file` cannot record one lexical path while modifying or deleting a different linked file object.
- Wrapped malformed `package.json` failures in `diagnose_workspace` with a tool-specific invalid-manifest error so diagnostics setup failures remain traceable to the workspace package being inspected.
- Filtered TypeScript diagnostic paths so `diagnose_workspace` and `diagnose_file` only return diagnostics whose source path remains inside the active workspace.
- Verification plan: command tool tests cover cross-thread session denial, session spawn failure state, Windows `taskkill` fallback, deleted-file Git pathspecs, hidden and magic pathspec rejection, git log ref validation, package script-name validation, npm frozen-lockfile install behavior, symlink-path coding tool rejection, invalid diagnostic package manifests, workspace-bound diagnostic paths, plus the existing command/coding tool safety regressions; full `typecheck/test/build` verification is run before handoff.

### 2026-06-10 - Code workbench long timeline performance
- Optimized Code `MessageTimeline` for long histories by windowing at the raw
  `Item[]` boundary before turn grouping. The initial render keeps the latest
  turns together without splitting a shared `turnId`, and exposes a localized
  show-older control for loading the full history on demand.
- Stabilized timeline text ordering by sorting items by `createdAt` with stable
  tie-breaking before turn grouping and recent-window selection, so replay/SSE
  arrival order no longer affects visible user/reasoning/tool/assistant order.
- Reduced folded historical render cost: closed work-process sections no longer
  mount their process item blocks, closed completed reasoning renders only a
  lightweight text preview, and collapsed long code blocks render a bounded
  source preview while retaining full-source copy and expand behavior.
- Hardened `RightInspector` for long Code sessions: Changes now summarizes
  only recent tool activity, tool details use bounded preview formatting that
  avoids building full large result strings, and Todo/Plan latest-plan lookup
  scans from the end instead of collecting all plan items.
- Verification plan: renderer MessageTimeline, timeline-model and
  RightInspector helper tests cover recent-window boundaries, stable sorting,
  folded reasoning/code previews, bounded tool previews and latest-plan lookup;
  full `typecheck/test/build` verification is run before handoff.

### 2026-06-10 - Write document state and completion race cleanup
- Consolidated Write document view state reset/open paths so file open, file
  clear and workspace-switch branches share the same active path, content,
  saved content, inline completion and editor-selection defaults.
- Hardened inline completion settling so stale responses are ignored unless the
  request id, workspace and active Markdown path still match the current editor
  context.
- Verification plan: renderer Write workspace helper tests cover centralized
  document view state, unchanged selection checks and completion response
  guards; full `typecheck/test/build` verification is run before handoff.

### 2026-06-10 - Write large document performance hardening
- Hardened Write editor performance for large Markdown files. The source
  textarea now uses a hybrid uncontrolled boundary so normal typing does not
  force React to rewrite the whole document string on every keystroke, while
  programmatic updates such as file switches and completion acceptance still
  synchronize the DOM value.
- Added a large-document source mode that disables soft wrapping, spellcheck,
  autocomplete and autocapitalize to reduce browser layout/text-assist work for
  very large Markdown source files.
- Made Write preview rendering snapshot-based: small documents remain live,
  medium documents refresh after typing pauses, and very large documents pause
  automatic Markdown rendering until the user explicitly refreshes the preview.
  `AssistantMarkdown` is memoized so unchanged preview snapshots do not reparse
  through `react-markdown` / `remark-gfm`.
- Bounded inline completion prefix/suffix extraction around the current
  selection so large documents do not slice and send the full source body for
  local Markdown completion.
- Verification plan: renderer tests cover preview modes, large source mode,
  hybrid textarea synchronization, caret line counting, bounded completion
  context and large-document SSR markup; full `typecheck/test/build`
  verification is run before handoff.

### 2026-06-10 - Write document context menu viewport clamp
- Hardened the Write document context menu so right-click actions are clamped
  inside the visible viewport near right and bottom edges, with CSS width and
  max-height bounds as a layout fallback for narrow windows.
- Verification plan: renderer Write workspace helper tests cover normal,
  edge, negative-coordinate and tiny-viewport positioning; full
  `typecheck/test/build` verification is run before handoff.

### 2026-06-10 - Write workbench session management layout
- Reworked the Write workbench sidebar into distinct navigation, workspace,
  writing session and Markdown document sections. The active Write route now
  exposes the current Write tab state beside Code and Settings controls.
- Reused the shared thread session list behavior for `mode: "write"` sessions,
  including selection, archive, restore, delete and archived visibility. New
  writing sessions are created through the existing `threads.create` path with
  `mode: "write"`.
- Guarded writing-session switches and creation behind the existing dirty
  Markdown save flow, so a failed document save keeps the user in the current
  Write context instead of switching sessions.
- Verification: targeted renderer tests passed, followed by full
  `npm run typecheck`, `npm run test`, `npm run build`, and `git diff --check`.

### 2026-06-10 - Write document management and assistant composer upgrade
- Added Write document management IPC and UI for Markdown create, rename and
  delete. The main Write file service now exposes `write:create`,
  `write:rename` and `write:delete`, keeps all operations inside the active
  workspace policy, rejects non-Markdown paths, and avoids overwriting existing
  create/rename targets.
- Upgraded the Write sidebar into a document-management area with a document
  toolbar, inline create/rename forms, inline delete confirmation, row busy
  state and right-click context menu actions.
- Tightened renderer-side Write document path handling: create/rename inputs
  now normalize separators and reject ambiguous relative paths before IPC.
  Deleting the active dirty document now treats inline confirmation as an
  explicit discard decision instead of saving the draft immediately before
  removing the file.
- Enabled image attachments and quick model selection in the Write assistant
  composer while keeping plan/goal controls hidden. Successful Write assistant
  sends now clear composer attachments after starting the turn.
- Verification: targeted Write IPC/preload/renderer composer tests passed;
  full `npm run typecheck`, `npm run test`, and `npm run build` verification is
  run before handoff.

### 2026-06-10 - Code workbench sidebar action hardening
- Hardened Code sidebar thread actions with a local submitting state for
  archive, restore and delete confirmation. While one action is submitting,
  row action buttons are disabled, the active row exposes `aria-busy`, and
  callback rejections are routed into the shared workbench error state.
- Moved the Code timeline empty-state layout from inline JSX style into the
  `ds-message-timeline-empty` shell class so the stage structure stays in the
  shared style layer.
- Verification: `npm test -- tests/renderer/sidebar.test.ts
  tests/renderer/workbench-stage.test.tsx`, `npm run typecheck`,
  `npm run test`, `npm run build`, and `git diff --check`.

### 2026-06-10 - Write workbench interaction hardening
- Hardened Write file/editor interactions: rejected `write.get` and inline
  completion IPC calls now surface through the Write status error path, manual
  workspace open/refresh cancels pending debounced search reloads, and double
  click resets the Write sidebar divider to the shared default width.
- Tightened inline completion behavior so requests require enough text before
  the current caret/selection boundary, accepting a completion restores the
  textarea selection near the inserted text, and assistant timeline limiting
  preserves the complete leading turn instead of starting mid-turn.
- Verification: `npm test -- tests/renderer/write-workspace-view.test.ts
  tests/renderer/workbench-stage.test.tsx`, `npm run typecheck`,
  `npm run test`, `npm run build`, and `git diff --check`.

### 2026-06-10 - Write workbench audit fixes
- Closed the Write workbench audit follow-up: the Write route now passes
  approval handlers into the assistant panel, renders grouped turn process
  items with reasoning/tool/approval/plan visibility, and shows the pending
  approval panel with submitting allow/deny states.
- Upgraded the Write editor to a source/preview split using the shared safe
  Markdown renderer, moved local completion display near the caret context, and
  sends only explicit selected text or bounded nearby snippets as assistant
  context.
- Added Write sidebar resizing with the shared left-sidebar width range,
  improved disabled save/status layout, and replaced unstable metadata/diff
  separators with a stable `|` separator.
- Verification: `npm run typecheck`, `npm run test`, `npm run build`.

### 2026-06-10 - Workbench stage component split
- Split the renderer workbench stage JSX into `CodeWorkbenchStage` and
  `WriteWorkbenchStage`, while keeping `Workbench.tsx` as the owner for SSE,
  IPC, send/interrupt, approval and route orchestration.
- Split the Write route main panes into controlled `WriteEditorPanel` and
  `WriteAssistantPanel` components. `WriteWorkspaceView` still owns file list,
  active file, dirty content, completion, autosave, save refs, workspace refs
  and Write IPC calls.
- Added renderer markup coverage for the extracted stage and panel components,
  including Code composer layout, Write floating toast, editor ghost text and
  Write composer variant boundaries.
- Verification: `npm run typecheck`, `npm run test`, `npm run build`.

### 2026-06-10 - Settings advanced category filter
- Added a functional "show advanced settings" switch to the Settings sidebar.
  The default view keeps core categories visible, while runtime/model tuning and
  tool-detail categories appear when advanced settings are enabled.
- Verification: `npm run typecheck`, `npm run test`, `npm run build`.

### 2026-06-10 - Code block collapsed preview hint
- Added a visible preview hint for long AssistantMarkdown code blocks while
  they are collapsed, including the total line count. Short code blocks remain
  unchanged, and the existing expand/collapse and copy controls keep their
  behavior.
- Verification: `npm run typecheck`, `npm run test`, `npm run build`.

### 2026-06-10 - Markdown code render completion fix
- Fixed AssistantMarkdown code rendering so fenced code blocks render from their
  extracted source string instead of relying on an already-rendered child node,
  and whitespace-only inline code no longer creates empty placeholder pills.
- Verification: `npm run typecheck`, `npm run test`, `npm run build`.

### 2026-06-10 - Settings session copy cleanup
- Cleaned the Workbench Settings session copy so it only describes the controls
  that still exist: archived-thread visibility and workspace restore. Thread
  delete confirmation is now a mandatory Sidebar interaction, not a Settings
  toggle.
- Verification: `npm run typecheck`, `npm run test`, `npm run build`.

### 2026-06-10 - Shared code/write FloatingComposer
- Refactored `FloatingComposer` into a shared renderer composer composed from
  attachment tray, toolbar, send controls, draft, attachment and popover hooks.
  The public send callback now receives `{ text, attachmentIds, mode, goalMode }`
  instead of a bare text string.
- Migrated `WriteWorkspaceView` to render `FloatingComposer variant="write"`.
  The Write variant keeps the shared draft/send/interrupt behavior while hiding
  attachments, the `+` menu, plan/goal and model controls.
- Cleaned composer draft ownership so the textarea is the local controlled
  source, removed the legacy key-code submit guard, and made popover
  `aria-controls` attributes conditional on the matching popover being mounted.
- Verification: `npm run typecheck`, `npm run test`, `npm run build`.

### 2026-06-10 - Settings category unsaved-change guard
- Fixed Settings sidebar category navigation so it uses the same unsaved model
  profile guard as section tabs, profile activation, create, duplicate, delete
  and back-to-workbench actions. Dirty model edits can no longer be lost by
  switching from one model category to another through the left nav.
- Verification: pending.

### 2026-06-10 - Chat timeline and composer width alignment
- Added `--ds-chat-content-max-width` as the shared Code chat content column
  width. The timeline content and composer frame now both use that token, while
  `--ds-chat-composer-max-width` remains as an alias for existing references.
- Updated the UI design and layout reference docs to make timeline/composer
  horizontal alignment a documented layout invariant.
- Verification: pending.

### 2026-06-10 - AppShell route fallback style cleanup
- Moved the lazy route fallback surface styling out of `AppShell.tsx` inline
  styles and into the `ds-route-fallback` class in `shell.css`, keeping the same
  full-size `var(--ds-bg-main)` surface and opacity.
- Verification: `npm run typecheck`, `npm run test`, `npm run build`.

### 2026-06-10 - Workbench chat layout class cleanup
- Moved static Code chat stage layout values out of `Workbench.tsx` inline
  styles and into `shell.css` classes for the topbar frame, stage body, chat
  column, composer dock, and composer width frame. Dynamic sidebar width remains
  inline because it is user-controlled state.
- Added `--ds-space-3` and `--ds-chat-composer-max-width` tokens so the 12px
  frame spacing and 720px composer width have a single local source.
- Verification: `npm test -- tests/renderer/workbench.test.ts`, plus full
  `typecheck`, `test`, and `build`.

### 2026-06-10 - Tool detail preview control
- Added a renderer-only preview boundary for long tool args/results in chat
  process entries. Tool records still use the persisted `ToolItem` data, but
  long detail text now renders as a bounded preview with an explicit show-full /
  show-preview button.
- Kept tool duration out of the UI because the current shared `ToolItem`
  contract has `createdAt` but no completion timestamp.
- Verification: `npm test -- tests/renderer/chat-block.test.ts`, plus full
  `typecheck`, `test`, and `build`.

### 2026-06-10 - Composer textarea autosize and toolbar classes
- Added `syncComposerTextareaHeight()` so the Code composer textarea resets to
  `auto` and then follows its `scrollHeight` after draft changes, while the CSS
  min/max height continues to bound the control.
- Moved remaining static FloatingComposer shell/toolbar/action inline layout
  styles into `shell.css` classes. Dynamic composer state remains in React.
- Verification: `npm test -- tests/renderer/floating-composer.test.ts`, plus
  full `typecheck`, `test`, and `build`.

### 2026-06-10 - Markdown image lazy loading guard
- Exported and covered `normalizeMarkdownImageSrc()` so Markdown image rendering
  has the same explicit safety-test boundary as links: `http(s)` and supported
  image data URLs render, unsafe/local protocols do not.
- Safe Markdown images now include both `loading="lazy"` and `decoding="async"`
  to avoid blocking the message timeline on large model-rendered images.
- Verification: `npm test -- tests/renderer/assistant-markdown.test.tsx`, plus
  full `typecheck`, `test`, and `build`.

### 2026-06-10 - Write workspace layout class cleanup
- Moved remaining static Write workspace sidebar/action/status inline layout
  styles into `shell.css` classes. The only retained inline Write sidebar style
  is the dynamic width/flex-basis derived from `state.leftSidebarWidth`.
- Verification: `npm test -- tests/renderer/write-workspace-view.test.ts`, plus
  full `typecheck`, `test`, and `build`.

### 2026-06-10 - Settings search field-keyword matching
- Expanded Settings sidebar search from category label/description/id matching
  to category-owned setting labels, descriptions and primary option text.
  Search stays scoped to the active top-level Settings section and still returns
  category-level navigation results.
- Added focused helper coverage so concrete setting terms such as compact
  limits can route users to the owning category instead of producing an empty
  search result.
- Verification: `npm test -- tests/renderer/settings-view.test.ts`, plus full
  `typecheck`, `test`, and `build`.

### 2026-06-10 - Completed reasoning default-open preference
- Added `openReasoningByDefault` to renderer basic preferences with `false` as
  the compatibility default, preserving completed/replayed reasoning as folded
  for existing localStorage payloads.
- Workbench Settings now exposes the toggle in Layout settings. Live reasoning
  still opens while streaming; completed reasoning follows the persisted
  preference until the user manually toggles the details entry.
- Verification: `npm test -- tests/renderer/chat-block.test.ts
  tests/renderer/preferences.test.ts tests/renderer/settings-i18n.test.ts
  tests/renderer/workbench-context.test.tsx`, plus full `typecheck`, `test`,
  and `build`.

### 2026-06-10 - Code block fold threshold preference
- Added `codeBlockCollapseLineThreshold` to renderer basic preferences with a
  normalized `1..200` range and the existing 18-line behavior as the default.
- Workbench Settings now exposes the threshold in Layout settings with draft
  validation on blur/Enter and Escape reset; invalid drafts show a local
  Settings error instead of silently changing rendering behavior.
- `ChatBlock` passes the persisted threshold into `AssistantMarkdown`, so
  assistant and reasoning Markdown code blocks use the user-configured fold
  threshold.
- Verification: `npm test -- tests/renderer/assistant-markdown.test.tsx
  tests/renderer/preferences.test.ts tests/renderer/settings-view.test.ts
  tests/renderer/settings-i18n.test.ts tests/renderer/chat-block.test.ts
  tests/renderer/workbench-context.test.tsx`, `npm run typecheck`,
  `npm run test`, and `npm run build`.

### 2026-06-10 - Thread delete confirmation hardening
- Removed the Settings toggle and renderer preference branch that allowed thread
  deletion to bypass inline confirmation. Sidebar delete now always enters the
  existing two-step confirmation state before calling the delete API.
- Dropped the unused `confirmThreadDelete` basic preference field from renderer
  preference normalization and removed the stale i18n/settings documentation for
  that no-longer-effective control.
- Verification: `npm test -- tests/renderer/sidebar.test.ts
  tests/renderer/preferences.test.ts tests/renderer/settings-view.test.ts
  tests/renderer/workbench-context.test.tsx`, `npm run typecheck`,
  `npm run test`, and `npm run build`.

### 2026-06-10 - Message timeline jump-to-bottom
- Added a localized timeline jump-to-bottom affordance that appears only after
  the user scrolls away from latest output. Activating it restores the latest
  position and re-enables sticky bottom following for new stream updates.
- The button reuses existing design tokens for border, surface, focus and
  shadow styling, avoiding a new one-off visual token.
- Verification: `npm test -- tests/renderer/message-timeline.test.ts`,
  `npm run typecheck`, `npm run test`, `npm run build`, and
  `git diff --check`.

### 2026-06-10 - Composer IME Enter guard
- Fixed Composer keyboard submit handling so plain Enter still sends and
  Shift+Enter still inserts a newline, but Enter is ignored while IME composition
  is active.
- The guard now relies only on the browser IME composition state, avoiding a
  second legacy key-code dimension in the submit path.
- Verification plan: renderer Floating Composer helper tests cover plain Enter,
  Shift+Enter and active composition; full `typecheck/test/build` verification
  is run before handoff.

### 2026-06-10 - Follow-system theme listener
- Fixed the renderer theme helper so enabling follow-system theme registers a
  `prefers-color-scheme` listener and updates `<html data-theme>` when the OS
  light/dark preference changes.
- Manual light/dark theme selection now removes the system listener by disabling
  follow mode, so stale OS changes cannot override the explicit user choice.
- Verification: `npm test -- tests/renderer/theme.test.ts` and
  `npm run typecheck`.

### 2026-06-10 - Model API key encrypted persistence
- Added a main-process secret codec boundary for `userData/config` so non-empty
  model `OPENAI_API_KEY` values are encrypted on disk while the existing
  in-memory `ModelConfig`, IPC and renderer contracts remain unchanged.
- Legacy plain-text model API keys are decrypted as plain input and migrated to
  the encrypted `encrypted:v1:` disk representation on the next normalized
  config write.
- Shared config writes from both `ModelConfigStore` and `RuntimePreferencesStore`
  use the same injected codec, so runtime preference saves preserve encrypted
  model profile secrets instead of rewriting them as plain text.
- Verification: `npm test -- tests/main/persistence/model-config-store.test.ts`,
  `npm test -- tests/main/persistence/runtime-preferences-store.test.ts`, and
  `npm run typecheck`.

### 2026-06-10 - Shared approval pending response state
- Lifted renderer approval response pending state to `Workbench` so the durable
  timeline approval block and composer-adjacent pending approval panel share the
  same `approvalId` submission state.
- Duplicate allow/deny clicks for the same approval id are ignored before a
  second IPC request can be sent. Failed IPC responses release the local pending
  state; successful responses remain disabled until the resolved approval item is
  pushed back through runtime events.
- Verification plan: renderer Workbench, MessageTimeline and ChatBlock helper
  tests cover duplicate pending registration, resolved-item cleanup and shared
  pending button rendering; full `typecheck/test/build` verification is run
  before handoff.

### 2026-06-10 - Settings runtime preference save queue
- Replaced the Settings runtime preference in-flight drop with a merged pending
  update queue. Runtime preference controls still allow only one active IPC save,
  but rapid subsequent changes are deep-merged by setting group and flushed after
  the active save settles instead of being silently discarded.
- Verification: `npm test -- tests/renderer/settings-view.test.ts` and
  `npm run typecheck`.

### 2026-06-10 - Preload SSE payload guard
- Hardened the preload `sse:push` bridge so it validates pushed payloads with
  shared `isRuntimeEvent()` before notifying renderer listeners. Malformed
  runtime event payloads are now dropped with a traceable preload warning instead
  of entering Workbench state through `agentApi.sse.onEvent()`.
- Verification: `npm test -- tests/preload/index.test.ts`, `npm test --
  tests/preload/index.test.ts tests/main/ipc/sse-handlers.test.ts
  tests/renderer/workbench.test.ts`, `npm run typecheck`, `npm run test`,
  `npm run build`, and `git diff --check`.

### 2026-06-10 - Worker postMessage failure cleanup
- Hardened `LlmWorkerPool.chat()` so synchronous failures while posting the
  initial worker chat message clean request listeners, active request counts and
  cancel handles before rejecting as `worker_crashed`. This prevents a closed or
  broken worker port from leaving stale request state that can affect later
  routing or cancellation for the same thread.
- Verification: `npm test -- tests/main/infrastructure/worker-pool.test.ts`,
  `npm test -- tests/main/application/agent-runtime.test.ts
  tests/main/infrastructure/worker-pool.test.ts`, `npm run typecheck`,
  `npm run test`, `npm run build`, and `git diff --check`.

### 2026-06-10 - Turn interrupt stale id boundary
- Hardened `AgentRuntime.interruptTurn()` so unknown or already completed turn
  ids throw instead of being reported as successful no-op interrupts through
  IPC. Repeated interrupts for the same in-flight turn that is already marked
  `interrupted` remain idempotent and do not append duplicate interrupt notices
  or send duplicate worker cancel requests.
- Verification: `npm test -- tests/main/application/agent-runtime.test.ts
  tests/main/ipc/turns-handlers.test.ts`, `npm run typecheck`,
  `npm run test`, `npm run build`, and `git diff --check`.

### 2026-06-10 - Usage daily DST date window
- Fixed `usage:daily` bucket generation so the date window advances by local
  calendar days instead of fixed 24-hour millisecond offsets. This prevents
  duplicate or skipped bucket labels across daylight-saving time transitions.
- Verification: `npm test -- tests/main/ipc/usage-handlers.test.ts`.

### 2026-06-10 - Thread delete retry handle
- Hardened `JsonlThreadStore.deleteThread()` so recursive thread directory
  deletion happens before removing the `threads/index.json` row. If filesystem
  deletion fails, the thread id remains listed and cleanup can be retried instead
  of leaving an unreachable orphan session directory.
- Verification: `npm test -- tests/main/persistence/jsonl-thread-store.test.ts`.

### 2026-06-10 - Attachment delete retry handle
- Hardened `AttachmentStore.delete()` so blob deletion happens before removing
  the metadata index entry. If the filesystem delete fails, the attachment id
  remains listed and cleanup can be retried instead of leaving an unreachable
  orphan blob.
- Verification: `npm test -- tests/main/persistence/attachment-store.test.ts`.

### 2026-06-10 - Write and composer active semantics
- Added semantic active-state hints for Write and Composer controls: Write file rows now expose the active file with `aria-current="page"`, the Markdown editor has an explicit label, and Composer plan/goal mode rows expose pressed state.
- Verification plan: renderer Write workspace markup tests cover the editor label; full `typecheck/test/build` verification is run before handoff.

### 2026-06-10 - Settings sidebar active semantics
- Added `aria-current="page"` to the active Settings sidebar category button so the left navigation exposes the same current-page state as its visual `is-active` styling.
- Added current-state semantics to the active Settings model profile card button so profile selection exposes the same state as the visual `is-active` styling and active badge.
- Verification plan: renderer SettingsSidebar markup tests cover the active category current state; full `typecheck/test/build` verification is run before handoff.

### 2026-06-10 - Composer model picker semantics
- Added dialog semantics to the Composer model picker popover and exposed active model profile / reasoning effort buttons through `aria-pressed`, keeping accessible state aligned with the visual `is-active` state.
- Added stable `aria-controls` relationships for the Composer `+` menu and model picker buttons, with matching popover ids.
- Aligned the Composer `+` menu DOM with its `aria-haspopup="menu"` trigger by adding menu/menuitem/menuitemcheckbox roles and checked state for plan/goal toggles.
- Removed the redundant `aria-pressed` state from Plan/Goal
  `menuitemcheckbox` rows so their active state is exposed through
  `aria-checked` only.
- Verification plan: renderer model picker markup tests cover the dialog label and active pressed states; full `typecheck/test/build` verification is run before handoff.

### 2026-06-10 - Settings model profile edit gating
- Disabled model profile form controls while profile data is loading/saving, while create/activate/duplicate/delete operations are busy, or when the preload API is unavailable, so delayed profile responses cannot overwrite newer user edits.
- Extended `SecretInput` with a disabled state for API key editing and visibility toggling.
- Restricted the Settings form submit path to model configuration categories, so the profile list category cannot submit an update with unchanged form state through the outer page form.
- Verification plan: Settings helper tests cover the model profile control disable boundary; full `typecheck/test/build` verification is run before handoff.

### 2026-06-10 - Deleted profile default cleanup
- Fixed model profile deletion so `ModelConfigStore.deleteProfile()` clears Code/Write default model profile ids in `runtimePreferences` when they point at the deleted profile. This keeps the shared `userData/config` file from retaining dangling default profile references after Settings or IPC deletes a profile.
- Extended shared config normalization so older or manually edited config files also clear stored Code/Write default profile ids that no longer match any normalized profile.
- Hardened `RuntimePreferencesStore.update()` so new non-null Code/Write default profile ids must reference an existing model profile instead of persisting a dangling id through IPC.
- Synced Settings deletion UI with the main-process cleanup by refreshing `runtimePreferences` after profile deletion, with a local fallback that clears defaults pointing at the deleted profile if the refresh fails.
- Rechecked the renderer delete path and wired the refresh/fallback into the
  actual `handleDeleteProfile()` success branch so Code/Write default selects and
  Workbench runtime state update immediately after a profile is deleted.
- Verification: `npm test -- tests/main/persistence/model-config-store.test.ts`, `npm test -- tests/main/persistence/runtime-preferences-store.test.ts`, `npm test -- tests/renderer/settings-view.test.ts`, `npm run typecheck`, `npm run test`, `npm run build`, and `git diff --check`.

### 2026-06-10 - Write IPC commit path revalidation
- Hardened `write.put` so Markdown writes re-run the shared workspace path policy after parent directory creation and before the final UTF-8 write. This closes the gap where a newly created parent directory could be swapped to a symlink outside the workspace between validation and commit.
- Verification: `npm test -- tests/main/ipc/write-handlers.test.ts`, `npm run typecheck`, `npm run test`, `npm run build`, and `git diff --check`.

### 2026-06-10 - Settings profile delete confirmation pruning
- Cleared stale Settings model-profile delete-confirmation state when the backing profile disappears from the current profile list, matching the Sidebar stale confirmation cleanup.
- Verification plan: renderer SettingsView helper tests cover keeping visible pending profile ids and clearing missing ones; full `typecheck/test/build` verification is run before handoff.

### 2026-06-10 - Sidebar delete confirmation state pruning
- Cleared stale Sidebar inline delete-confirmation state when the backing thread disappears from the current list, such as after archive/delete/list refreshes.
- Verification plan: renderer Sidebar helper tests cover keeping visible pending ids and clearing missing ones; full `typecheck/test/build` verification is run before handoff.

### 2026-06-10 - Renderer style token integrity
- Replaced the remaining `shell.css` references to undefined `--ds-surface` with existing surface tokens so Write assistant and Settings tool-access rows keep stable themed backgrounds.
- Added a renderer style-token test that checks every `var(--ds-*)` reference in `shell.css` resolves to a token defined in `tokens.css`.
- Verification plan: `npm test -- tests/renderer/style-tokens.test.ts`; full `typecheck/test/build` verification is run before handoff.

### 2026-06-10 - Controlled details toggle boundaries
- Hardened renderer reasoning and work-process folding so controlled `<details>` updates that only mirror live/completed defaults are not recorded as user overrides; only real open-state flips from the current controlled state persist as explicit toggles.
- Verification plan: renderer ChatBlock and MessageTimeline helper tests cover ignored programmatic details toggles and real user toggles; full `typecheck/test/build` verification is run before handoff.

### 2026-06-10 - Workbench deselect inspector cleanup
- Closed the Right Inspector when `WorkbenchContext` deselects the active thread, matching the existing remove-thread and cross-mode route cleanup paths so an empty active timeline cannot leave a stale inspector panel open.
- Verification plan: renderer WorkbenchContext reducer tests cover `deselectThread` clearing active selection, items, active turn, and `rightPanelMode`; full `typecheck/test/build` verification is run before handoff.

### 2026-06-10 - Settings profile activation runtime fallback
- Fixed Settings profile activation so a failed `runtimePreferences.get()` refresh preserves the current Code/Write default model profile ids instead of reusing the delete-profile fallback and clearing still-valid references.
- Kept the delete-profile fallback unchanged: deleting a profile still locally clears defaults pointing at the deleted profile if the runtime preference refresh fails.
- Verification plan: renderer SettingsView helper tests cover activation refresh failure preserving runtime preferences and delete fallback clearing only deleted profile references; full `typecheck/test/build` verification is run before handoff.

### 2026-06-10 - Right inspector close control text
- Replaced the RightInspector close button's visible glyph with stable ASCII text while keeping its localized `aria-label` and `title`, matching the other close/remove controls hardened against encoding drift.
- Verification plan: renderer RightInspector tests cover the close button visible text; full `typecheck/test/build` verification is run before handoff.

### 2026-06-10 - Sidebar resizer drag feedback
- Added explicit `is-dragging` visual state for the Code sidebar divider and Right Inspector resizer so pointer resizing keeps the active drag line highlighted until pointer up/cancel.
- Kept the existing keyboard sizing, double-click reset, and persisted width behavior unchanged.
- Verification plan: renderer Workbench and RightInspector helper tests cover the dragging class mapping; full `typecheck/test/build` verification is run before handoff.

### 2026-06-10 - Right inspector control relationship
- Added stable region/title ids to `RightInspector` and wired the Workbench topbar
  Inspector mode/toggle buttons with `aria-controls`; the open/close toggle now
  reflects panel visibility through `aria-expanded`.
- Verification plan: renderer WorkbenchTopBar and RightInspector helper tests
  cover the expansion helper and stable controlled-region ids; full
  `typecheck/test/build` verification is run before handoff.

### 2026-06-10 - Workbench error toast copy action
- Added a copy-to-clipboard action to Workbench runtime failure toasts so users can report the full error text without selecting wrapped toast content manually.
- Copy unavailable or rejected states now show transient failed feedback and log the renderer-side failure reason while leaving the dismiss action unchanged.
- Verification plan: renderer Workbench helper tests cover copy success, empty input, unavailable clipboard, and rejected clipboard writes; full `typecheck/test/build` verification is run before handoff.

### 2026-06-10 - Approval diff preview toggle boundary
- Preserved manual open/closed state for approval file diff previews after the user toggles them, while still applying `showDiffByDefault` until a manual override exists.
- Verification plan: renderer ChatBlock helper tests cover default syncing and user override behavior; full `typecheck/test/build` verification is run before handoff.

### 2026-06-10 - Empty-session usage heatmap semantics
- Exposed the empty-session daily usage heatmap as one labeled graphic and hid individual decorative cells from assistive tech, preserving the visible grid and tooltip behavior.
- Verification plan: renderer InitialSessionUsageHeatmap markup tests cover the heatmap role/label and hidden cells; full `typecheck/test/build` verification is run before handoff.

### 2026-06-10 - Assistant code block disclosure semantics
- Added an `aria-controls` relationship between long-code expand/collapse buttons and their rendered `<pre>` content in `AssistantMarkdown`.
- Verification plan: renderer AssistantMarkdown markup tests cover the button/content id relationship; full `typecheck/test/build` verification is run before handoff.

### 2026-06-10 - Assistant code copy control polish
- Added stable accessible labels and titles to Assistant Markdown code-block copy buttons while preserving transient copied/failed visible feedback. Copy failures now also reset back to idle after the short feedback window.
- Cleared pending code-copy feedback timers when a new copy result arrives or the code block unmounts, preventing stale feedback resets from racing later state.
- Verification plan: renderer AssistantMarkdown markup tests cover the copy button label/title; full `typecheck/test/build` verification is run before handoff.

### 2026-06-10 - Code/Write default profile send boundary
- Fixed Workbench turn send payloads so automatically synced active composer profiles are not sent as explicit `modelProfileId`; config-backed Code/Write default model profile preferences now reach `AgentRuntime.resolveModelProfile()` unless the user explicitly chooses a profile.
- Verification plan: renderer Workbench and WorkbenchContext tests cover the auto-vs-explicit composer profile boundary; full `typecheck/test/build` verification is run before handoff.

### 2026-06-10 - Development command tool suite
- Expanded `createCommandTools()` beyond `run_command` / TypeScript diagnostics with independently registered development tools: configurable shell execution, Git Bash, PowerShell/pwsh, WSL, regex `rg_search`, structured Git status/diff/log/branch/commit, package manager script/install/test/build wrappers, generic lint/format/test/build wrappers, bounded long-running command sessions, and shell environment detection.
- Kept foreground shell, Git commit, package/task, and command session write/stop operations on the approval path; read-only wrappers such as `rg_search`, Git status/diff/log/branch, package script discovery, session read, shell environment detection, and `diagnose_file` skip approval through metadata.
- Updated shared `RUNTIME_TOOL_NAMES`, default Code/Write availability, Code-only runtime policy, settings i18n/search metadata, and runtime/tool docs so model catalog filtering and renderer settings do not drift from the registered tool suite.
- Verification plan: command tool tests cover shell selection, WSL path conversion, regex search, Git wrappers, package/task wrappers, and session lifecycle; full `typecheck/test/build` verification is run before handoff.

### 2026-06-09 - Command output UTF-8 truncation
- Hardened `run_command` stdout/stderr truncation so byte-limited command output is decoded on a UTF-8 character boundary and does not introduce replacement characters into tool results.
- Verification: `npm test -- tests/main/application/tools.test.ts`, `npm run typecheck`, `npm run test`, `npm run build`, and `git diff --check`.

### 2026-06-09 - Stable visible close controls
- Replaced remaining renderer-visible close/remove glyphs in Write search clear and Composer attachment remove controls with stable ASCII text while keeping localized accessible labels and titles.
- Verification plan: renderer Write workspace and Floating Composer helper tests lock the stable visible text; full `typecheck/test/build` verification is run before handoff.

### 2026-06-09 - Pending approval auto-scroll trigger
- Changed `PendingApprovalPanel` auto-scroll from a count-only dependency to a pending approval identity signature, so replacing one pending approval with another still honors `autoScrollOnRequest`.
- Replaced the Workbench error-toast visible dismiss glyph with stable ASCII text while keeping the localized accessible label and title.
- Verification plan: renderer pending approval and Workbench helper tests cover the auto-scroll trigger decision and dismiss text; full `typecheck/test/build` verification is run before handoff.

### 2026-06-09 - Code block folding and post-answer ordering
- Added default folding for long renderer code blocks inside `AssistantMarkdown` while preserving the existing copy action and short-code expanded behavior.
- Tightened timeline sectioning so passive records that arrive after the final assistant answer, including reasoning, plan, system, and compaction items, stay after the answer instead of moving into the pre-answer work process.
- Verification plan: renderer Markdown and timeline model tests cover long-code folding and post-answer passive ordering; full `typecheck/test/build` verification is run before handoff.

### 2026-06-09 - Workbench IPC reject visibility
- Wrapped Workbench preload IPC calls so rejected `ipcRenderer.invoke()` promises are converted into traceable `IpcResult.err` values and routed through the existing workbench error toast instead of becoming unhandled promises.
- Verification plan: Workbench helper tests cover rejected promises and synchronous bridge throws; full `typecheck/test/build` verification is run before handoff.

### 2026-06-09 - Frontend timeline reasoning folding
- Updated renderer timeline grouping so non-assistant follow-up items that arrive after the final assistant answer remain after that answer instead of being folded back into the pre-answer work process.
- Rendered reasoning items as collapsible process entries. Live reasoning opens by default, while completed/replayed reasoning can stay folded until the user expands it.
- Verification plan: renderer timeline and chat block tests cover follow-up ordering and reasoning details rendering; full `typecheck/test/build` verification is run before handoff.

### 2026-06-09 - Settings runtime preference control gating
- Disabled runtime preference controls while Settings is loading or saving runtime preferences, and added an in-flight guard around `runtimePreferences.update()` so rapid repeated controls cannot submit overlapping saves.
- Surfaced rejected runtime preference IPC promises as Settings error state instead of leaving the runtime settings badge stuck in `saving`.
- Verification plan: settings helper tests cover preload-unavailable, loading, saving, idle, saved, and error states; full `typecheck/test/build` verification is run before handoff.

### 2026-06-09 - create_plan step status validation
- Consolidated plan step status values into shared `PLAN_STEP_STATUSES` and made `create_plan` reject unknown step statuses instead of silently downgrading them to `pending`; omitted status still defaults to `pending`.
- Verification: shared contract and application tools tests cover the shared status list, omitted status default, and invalid status rejection; full `typecheck/test/build` verification is run before handoff.

### 2026-06-09 - update_goal blank summary validation
- Fixed `update_goal` tool input parsing so a present but blank `summary` fails even when `goal` or `status` is also provided, matching `goal:update` IPC and `AgentRuntime.updateThreadGoal()` semantics instead of silently dropping the bad field.
- Verification: `npm test -- tests/main/application/tools.test.ts`; full `typecheck/test/build` verification is run before handoff.

### 2026-06-09 - Read-only tool name contract consolidation
- Moved renderer read-only tool record visibility from a component-local hardcoded list to shared `RUNTIME_READ_ONLY_TOOL_NAMES`, and added a main-process tool metadata test to keep the shared list aligned with built-in `metadata.isReadOnly` tools.
- Verification: shared contract, application tools, and message timeline tests cover the constant, metadata alignment, and failed read-only tool visibility; full `typecheck/test/build` verification is run before handoff.

### 2026-06-09 - RuntimeEventBus EventEmitter meta-event compatibility
- Fixed `RuntimeEventBus.emit()` validation so runtime events still require shared contract shape/kind consistency, while Node `EventEmitter` lifecycle meta events (`newListener` / `removeListener`) continue to pass through for listener diagnostics and cleanup hooks.
- Verification: `npm test -- tests/main/event-bus.test.ts`; full `typecheck/test/build` verification is run before handoff.

### 2026-06-09 - Thread goal object blank text guard
- Hardened the shared `ThreadGoal` guard and `JsonlThreadStore` normalization so complete goal objects with blank `text` or blank optional `summary` are rejected before they can enter thread update persistence or runtime events.
- Verification: shared contract, thread IPC, and JSONL thread store tests cover the blank goal object boundary; full `typecheck/test/build` verification is run before handoff.

### 2026-06-09 - Command timeout preference upper bound
- Hardened `run_command` and `diagnose_workspace` timeout handling: model-provided `timeout_ms` can now only reduce or match `RuntimePreferences.command.timeoutMs`, not raise execution time back to the global maximum.
- Verification: `npm test -- tests/main/application/tools.test.ts`; full `typecheck/test/build` verification is run before handoff.

### 2026-06-09 - Thread goal patch IPC boundary
- Hardened `thread:update` goal patch validation: the IPC parser now reuses the shared `ThreadGoal` guard and accepts only a complete `ThreadGoal` object or `null`, so malformed renderer payloads fail before store access instead of relying on persistence normalization.
- Verification: `npm test -- tests/main/ipc/threads-handlers.test.ts`, `npm run typecheck`, `npm run test`, and `npm run build`.

### 2026-06-09 - Settings composer attachment controls
- Added renderer-local Workbench Settings controls for composer image upload and clipboard image paste. The controls persist through `basicPreferences` and are consumed by `FloatingComposer`: upload disabling hides the image picker row and blocks stale file input changes, while paste disabling ignores clipboard image files without blocking regular text paste.
- Fixed composer attachment pending accounting for mixed accepted/rejected image batches: pending state now increments and decrements by accepted files only, so rejected oversized images cannot prematurely re-enable send/remove actions while another attachment upload is still running.
- Verification plan: renderer preference/composer/settings/i18n tests cover normalization, source gating and localized labels; complete validation commands are recorded in the maintenance result.

### 2026-06-09 - Settings runtime controls polish
- 优化工具与权限里的命令限制控件：`command.timeoutMs` / `command.maxOutputBytes` 改为本地草稿输入，失焦或 Enter 时才按 shared runtime preference 边界校验并保存，Escape 回退当前持久化值，避免用户编辑中间态把空值、`0` 或越界值提交到主进程。
- 修复设置页新增 runtime 控件的 zh-CN 文案占位损坏，补齐协议、Code/Write 默认模型、审批/沙盒、工具、命令、压缩和审批展示相关中文标签，并新增 i18n 测试防止问号占位回归。
- 验证方式：`npm test -- tests/renderer/settings-view.test.ts tests/renderer/settings-i18n.test.ts`、`npm run typecheck`；完整验证见本轮维护结果。

### 2026-06-09 - Write IPC 路径策略硬编码收敛

- 收敛 Write IPC 文件服务的 workspace 路径策略：`write-handlers.ts` 不再复制 skipped directory、path escape、realpath 与 symlink 防护逻辑，改为复用 `workspace-policy.ts` 的共享策略；Write 层只保留 Markdown 扩展名限制和自己的 `WRITE_*_FAILED` envelope。
- 验证方式：扩展 Write IPC path 测试覆盖点目录跳过，复用既有 DeepSeek/out/node_modules、path escape、symlink 和 Markdown 限制测试；完整验证命令见本次维护结果。

### 2026-06-09 - Attachment MIME 类型硬编码收敛

- 收敛附件图片 MIME 类型规则：`SUPPORTED_ATTACHMENT_MIME_TYPES` 和 `normalizeSupportedAttachmentMimeType()` 现在由 `src/shared/agent-contracts.ts` 提供，`AttachmentStore` 与 `FloatingComposer` 共同使用该契约，避免 renderer 允许类型和主进程持久化允许类型漂移。
- 收敛附件大小上限：`MAX_ATTACHMENT_BYTES` 现在同样由 shared contract 提供；`AttachmentStore` 继续强校验，`FloatingComposer` 在读取 base64 和调用 `attachments.create` 前用同一上限拦截超大图片并显示本地化错误。
- 验证方式：扩展 shared contract、AttachmentStore 和 FloatingComposer 单元测试覆盖 MIME 类型列表、大小写/空白归一化、大小上限和 renderer 上传前分流；完整验证命令见本次维护结果。

### 2026-06-09 - Tool schema 数值契约硬编码收敛

- 收敛 workspace/command 工具 schema 中的参数默认值和上限说明：`list_files.max_entries`、`read_file.max_bytes`、`search_files.max_results` 与 `run_command` / `diagnose_workspace.timeout_ms` 的描述现在由执行时使用的同一组常量生成，避免模型看到的工具契约与运行时校验漂移。
- 验证方式：扩展 application tools 单元测试覆盖 workspace limit schema 与 command timeout schema；完整验证命令见本次维护结果。

### 2026-06-09 - Goal update 空更新与 clear 冲突边界加固

- 对齐 `goal:update` IPC、`update_goal` 工具和 `AgentRuntime.updateThreadGoal()` 的输入语义：空更新、空白 goal/summary、以及 clear 与 status/summary 混用现在都会失败，避免无业务变化只刷新 goal `updatedAt` 或冲突字段被静默忽略。
- 验证方式：扩展 goal IPC 和 AgentRuntime 单元测试覆盖空更新、clear 冲突和空白 summary；完整验证命令见本次维护结果。

### 2026-06-09 - Thread update 空 patch 边界加固

- 修复 `thread:update` 空 patch 假成功问题：IPC parser 与 `JsonlThreadStore.updateThread()` 现在都会拒绝 `{}` 或只包含未知字段的更新，避免无业务字段变化却刷新线程 `updatedAt` 或向 renderer 报告保存成功。
- 验证方式：扩展 thread IPC 和 JSONL thread store 单元测试覆盖空 update patch；完整验证命令见本次维护结果。

### 2026-06-09 - SSE 全局运行时错误投递修复

- 修复 SSE push 兼容边界：`sse-handlers.ts` 现在为每个已订阅窗口维护单一全局 `runtime_error` 监听器，无 `threadId` 的进程级错误会投递一次；带 `threadId` 的错误继续走原有 thread subscription，避免多 thread 订阅窗口收到重复全局错误。
- 验证方式：扩展 SSE IPC 单元测试覆盖全局错误单次投递、线程级错误按订阅过滤、unsubscribe 与 webContents destroyed 后清理全局监听；完整验证命令见本次维护结果。

### 2026-06-09 - Renderer SSE 后台生命周期投影修复

- 修复 Workbench runtime event 分发边界：保留的后台 thread SSE subscription 即使在 Code/Write route 切换后清空 active thread，也会继续消费 `turn_started` / `turn_completed` / `turn_failed` 生命周期事件并维护 `inFlightTurnsByThreadId`；timeline item 仍只写入当前 active thread，避免后台内容污染当前对话。
- 验证方式：新增 renderer 单元测试覆盖无 active thread 时的后台 turn 生命周期事件，以及后台 item 不进入 active timeline；完整验证命令见本次实现结果。

### 2026-06-09 - Runtime turn start 必填字段边界加固

- 收紧 `AgentRuntime.startTurn()` 请求归一化：`threadId` 与 `text` 必须在 trim 后非空，避免畸形 IPC payload 依赖下游 UUID 校验或写入空白 user item；正常 renderer 发送路径已在进入 runtime 前 trim 文本，行为保持一致。
- 验证方式：扩展 AgentRuntime malformed turn start 测试覆盖空白 `threadId` / `text` 且失败后不产生 worker 请求或持久化 item；完整验证命令见本次实现结果。

### 2026-06-09 - Model config no-op 更新边界加固

- 修复 model config IPC parser 的空更新问题：`config:model:update` 现在拒绝 `{}`，profile update 也会拒绝只有 `id` 或 `config: {}` 的 payload，避免无业务字段变化却写入新的 `updatedAt` 或向用户报告保存成功；profile create 仍允许 `config: {}` 作为创建默认配置 profile。
- 同步加固 `ModelConfigStore` 持久化边界：直接调用 active config update 或 profile update 时，空对象、只有未知字段的对象、以及 profile `config: {}` 都会失败，避免绕过 IPC parser 后仍产生 false-success。
- 验证方式：扩展 model-config IPC 单元测试覆盖空 update、空 profile update、空 config update envelope，以及 create 默认配置 profile；完整验证命令见本次实现结果。

### 2026-06-09 - Renderer 半成品 Inspector 与绑定状态清理

- 清理未实现的右侧 Inspector `file` 模式：`RightPanelMode` 只保留当前可打开的 `changes`、`todo`、`plan`，删除空 `FilePanel` 占位和未使用 i18n 文案，避免类型层保留不可达半成品功能。
- 修复 Write workspace 绑定返回值：复用已有 thread 时，若 thread 或 timeline items 加载失败，`selectOrCreateThreadForWorkspace()` 会返回失败，Write 文件列表不会继续按成功绑定路径加载。
- 清理 `AppShell` 挂载时重复清空线程列表的无效 effect，避免启动阶段产生无意义状态写入。
- 加固 workspace thread 选择：`findLatestThreadForWorkspace()` 现在按 `updatedAt` 选择最新 active thread，不再依赖输入数组排序。
- 验证方式：扩展 renderer 单元测试覆盖非排序 thread 输入；完整验证命令见本次维护结果。

### 2026-06-09 - Windows 运行兼容优化

- 新增主进程路径比较辅助：workspace tools、coding tools 和 Write IPC 的路径边界判断改为按宿主平台语义比较，Windows 下兼容盘符/路径大小写差异，同时保留 path escape 与 skipped directory 防护。
- 加固命令工具跨平台执行：`run_command` / `diagnose_workspace` 不再依赖 Node 的隐式 `shell: true`，Windows 下显式走 `cmd.exe /d /s /c`，POSIX 下走 `$SHELL -c`；原有 timeout/interruption 的进程树终止策略保持不变。
- 加固 Windows 打包启动链路：LLM worker pool 优先解析 `out/main/llm-worker.js` 稳定构建入口；生产 file URL 导航校验改为文件路径比较，避免 Windows file URL 盘符/编码差异造成误判。
- 补充回归测试覆盖 Windows 风格路径大小写、shell invocation 和 worker 构建入口。
- 验证方式：`npm run typecheck`、`npm run test`、`npm run build`。

### 2026-06-09 - 前端设置与 Write 工作台可用性收口

- 修复 Settings 返回路径：`WorkbenchContext` 记录最近一次 code/write 工作台路由，设置页返回时回到来源工作台，避免从 Write 进入设置后被固定带回 Code。
- 加固 Write 工作台离开路径：从 Write 切到 Code 或 Settings 前会复用当前 Markdown 文档保存闸门；保存失败时保留在 Write 并暴露错误，避免自动保存尚未完成时静默离开。
- 增强 Write 工作台可用性：`WriteWorkspaceView` 现在在 Markdown 编辑器右侧提供 Write assistant 面板，写作请求来自显式输入并通过 `mode: "write"` thread 发送；发送路径不读取或清空全局 Code composer，也不携带 composer attachments。
- 修复 Write route 错误可见性：Workbench 全局 `errorMessage` toast 现在也会在 Write stage 以浮层显示，Write assistant / runtime / IPC 失败不再只写入不可见状态。
- 优化 Settings 表单反馈：模型 token 配置在 renderer 提交前先做本地化正整数、自动压缩阈值和最大输出 token 关系校验，减少等待 IPC 后才看到英文错误的情况。
- 补齐可访问性与资源清理：设计 token 新增 `--ds-focus-ring` 并统一设置页表单焦点反馈；Composer 在卸载时释放仍被追踪的 blob 预览 URL。
- 验证方式：补充 renderer 单元测试覆盖 settings 校验、Write 离开保存判断和最近工作台路由；完整验证命令见本次实现结果。

### 2026-06-09 - Code/Write 工作台与 tool 权限隔离

- 扩展 `AgentRuntime` tool access policy：默认在 `mode: "write"` 线程中隐藏并拒绝 `edit_file`、`write_file`、`apply_patch`、`rollback_file`、`run_command`、`diagnose_workspace`、`diagnose_file`，强制 tool call 会在 approval/execution 前记录 failed `ToolItem` 和 `runtime_error(code: "tool_not_found")`。
- 新增可配置权限入口：`createToolAccessPolicy()` 支持按 `code` / `write` mode 单独 allow 或 deny tool name；同一 mode/tool 同时 allow 与 deny 会在创建 policy 时失败；该层只控制 catalog/access，现有 approval 与 sandbox 策略仍在后续执行前生效。
- 修复 Workbench 线程边界：发送路径按当前 route 创建 `mode: "code"` 或 `mode: "write"` thread；workspace 选择会优先选中同 workspace 且 mode 匹配的 active thread，Write route 选择工作区时会选择或创建 Write thread。
- 闭合 Workbench route 隔离：Code route 侧栏只展示 Code threads；从 Write route 回到 Code route 时会清理不匹配的 active Write thread，避免 Code composer 继续向 Write thread 发送 turn。
- 修复旧线程数据兼容：缺失 `mode` 的旧 `ThreadRecord` / `ThreadSummary` 在 store 边界归一化为 `code`，非法 mode 值仍明确失败，避免 Write/Code tool policy 拿到 `undefined`。
- 修复 Write 编辑器状态越界：Markdown 文档编辑和 Tab 接受本地补全只更新 Write 本地文档状态，不再把全文写入全局 `composer.text`。
- 加固 `update_goal` 工具输入：非字符串 `summary` 现在会失败并进入可见 tool error，不再在同时存在其他字段时被静默忽略。
- 修复 Windows 命令中断：`run_command` 中断/超时时会终止 shell 子进程树，runtime 在 interrupted 终态前对已 abort 工具做有上限的 settle 等待，避免命令子进程继续占用 workspace。
- 修复 TypeScript workspace diagnostics 测试脚本跨平台 quoting：测试内的 `typecheck` script 改用 `node` 启动本仓库解析出的 `tsc`，避免带空格的 Node 绝对路径在 Windows npm script 下被截断。
- 加固 Write IPC 请求边界：`write.list/get/put/complete` 现在会在进入文件系统访问前校验请求对象和字符串字段，坏 payload 通过既有 `WRITE_*_FAILED` envelope 暴露明确错误。
- 加固 threads IPC：`thread:list/create/get/update/delete/fork` 现在会在进入 `JsonlThreadStore` 或 runtime busy gate 前校验请求对象、id、简单枚举与布尔字段，坏 payload 返回既有 thread error envelope；非法 update status 继续保留 `THREAD_STATUS_INVALID`。
- 加固 turns IPC：`turn:interrupt` 现在要求非空字符串 turnId，坏 payload 返回 `TURN_INTERRUPT_FAILED`，避免 malformed request 被 runtime no-op 包装成成功；`turn:get` 要求非空字符串 threadId，坏 payload 返回 `TURN_GET_FAILED` 且不会进入 store replay。
- 加固 attachments IPC：`attachment:create/get/delete` 现在会在进入 `AttachmentStore` 前校验请求对象和 id/string 字段，坏 payload 通过既有 `ATTACHMENT_*_FAILED` envelope 暴露且不会触发附件持久化初始化。
- 加固 usage IPC：`usage:daily` 仅在省略 request 时使用默认窗口；存在 request 时必须是对象且 `days` 必须为正整数，坏 payload 返回 `USAGE_DAILY_FAILED`，不再静默降级成成功查询。
- 加固 runtime event usage 守卫：`turn_completed.usage` 和 `TurnRecord.usage` 现在会按 `TokenUsage` 数值字段校验，坏 events JSONL 行会在 replay 边界跳过，避免 usage 聚合被字符串字段污染。
- 进一步收紧 usage/预算统计契约：`TokenUsage` 计数字段现在必须是非负整数，`cacheHitRate` 只能是 `null` 或 `0..1` 比例；OpenAI-compatible 与 Anthropic-compatible usage 映射复用同一非负整数边界，`tool_budget_reached` 的预算轮数和尝试调用数也按正整数校验。
- 加固 approval IPC：`approval:respond` 现在要求对象 payload、非空 approvalId 与 `allow | deny` decision，坏 payload 返回 `APPROVAL_RESPOND_FAILED` 且不会进入 runtime pending-approval 状态。
- 加固 model config profile IPC：`profiles:update/delete/activate` 现在会先校验非空 profile id；`profiles:update` 会拒绝 `config: null` / array 等坏 payload，避免被 store 当作 no-op 更新并写入新的 `updatedAt`。
- 加固 model config 字段输入：`config:model:update` 与 profile `config` payload 现在会在 IPC 边界校验 `thinking`、`OPENAI_API_KEY`、reasoning effort、autonomy 和 token 数值类型，避免 malformed 字段被 store normalize 成默认 thinking 或空 API key。
- 修正 model config 更新契约：`ModelConfigUpdate` 现在明确表示 partial update payload，和 store 的 active/default/existing profile merge 语义一致；完整持久化结果仍是 `ModelConfig`。
- 修复路径工具类型兼容：`path-utils` 不再引用当前 Node 类型未导出的 `path.PlatformPath`，保持 win32/posix 路径安全比较行为不变并恢复 typecheck。
- 修复 run_command 测试脚本 Windows quoting：测试 helper 不再把 `process.execPath` 当 JSON 字符串传给 `cmd /s /c`，Windows 下改用 base64 `node -e eval(...)` 形式，避免验证命令被 shell quote 误解析。
- 修复 Anthropic-compatible 无工具请求兼容性：`MiniMaxGateway` 现在只在工具列表非空时发送 `tools` 与 `tool_choice: auto`，避免 no-tool chat 请求被兼容服务误判为工具调用请求。
- 修复 Write workspace 绑定失败空错误：选择工作区时若无法选择或创建对应 Write thread，Write 状态栏会显示本地化失败原因；回调抛出的真实错误也会直接暴露。
- 补充回归测试覆盖 runtime 默认隔离、策略覆盖放行、Write 强制 Code-only tool call 拒绝、route-aware thread helper 和 Write 文档状态隔离。
- 验证方式：`npm run typecheck`、目标 Vitest；完整验证命令见本次实现记录。

### 2026-06-08 — 首轮维护审查修复

- 修复主进程启动关键初始化失败路径：`src/main/index.ts` 在持久化 stores 或 LLM worker pool 初始化失败时记录错误并重新抛出，阻止继续注册半可用 IPC handler 或创建工作台窗口。
- 加固线程 workspace 契约：`JsonlThreadStore.createThread()` 现在要求 `workspace` 为绝对路径，避免相对路径被写入 `ThreadRecord.workspace` 后在工具层按进程 cwd 隐式解析，保持持久化数据、UI 展示和 workspace realpath 边界一致。
- 加固 workspace 文件访问入口：workspace tools 与 Write 模式 IPC 现在同样拒绝相对 workspace，防止坏 IPC 数据或损坏 thread 记录绕过创建入口后被按主进程 cwd 隐式解析。
- 修复中断状态机竞态：`AgentRuntime.interruptTurn()` 会先把 active running tool item 写为 failed/interrupted 并阻止后台 tool settle 覆盖该状态，再发出 interrupted 终态，避免 replay 或 UI 看到 turn 已结束但工具仍停在 running。
- 清理未实现的跨进程预留字段：移除 `TurnInterruptOptions.force`、SSE `streamId/sinceIndex` 和 `WriteCompleteRequest.bypassCache`，让 shared contract 与当前 live-only SSE、本地 Markdown completion 和统一 interrupt 行为一致。
- 清理 approval IPC 契约：移除未被 runtime/UI 读取或持久化的 `ApprovalRespondRequest.reason`，避免调用方误以为 allow/deny 原因会被写入审计记录。
- 修复 LLM gateway 工具调用解析：OpenAI-compatible 与 Anthropic-compatible 的非流式/流式 tool call 缺少工具名时现在抛出明确 provider response 错误，不再生成空工具名或在流式路径静默丢弃工具调用。
- 修复 Write 模式打开文件竞态：`WriteWorkspaceView` 现在对 `write.get` 响应做请求序号、workspace 和 path 校验，避免连续点击文件时慢返回的旧内容覆盖当前 active file。
- 修复 Write 模式 workspace 切换失败污染：切换 workspace 会在 `write.list` 返回前立即清空旧文件列表和 active file，避免新 workspaceRoot 下保留旧 workspace 的相对路径和编辑内容。
- 修复线程活动时间投影：`JsonlThreadStore.appendItem()` 现在在消息追加后维护 `ThreadRecord.updatedAt` 和 `ThreadSummary.updatedAt`，renderer 的 `turn_started` 投影也会即时前移侧栏 summary，避免新消息后列表排序和时间仍停留在创建或手动更新时刻。
- 修复中断后 worker 正常返回竞态：`AgentRuntime.runTurn()` 在 `pool.chat` 正常返回后会先检查 interrupted 状态，保留中断前 partial stream 并忽略最终 response，避免用户已中断的 turn 又写入正常 assistant 输出。
- 清理 RightInspector 冗余类型出口：删除无仓库内消费者的 `Item` re-export 和旧 tree-shaking 注释，组件继续直接使用 shared contract 类型。
- 验证方式：新增持久化、workspace tool、Write IPC 测试覆盖相对 workspace 拒绝；扩展 AgentRuntime 中断测试覆盖 active tool 最终状态；完整验证命令见本次维护结果。

### 2026-06-08 — coding-agent 文件写入能力首批落地

- 扩展工具契约：`AgentTool` 支持 `metadata` 与 `preview()`，`AgentToolResult` 支持 `displayResult`，`ToolRegistry` 支持按名称取工具；runtime 在 approval 前可生成结构化预览，并把模型可读结果和 UI 展示结果分离。
- 新增共享 workspace 路径策略：`src/main/application/tools/workspace-policy.ts` 统一处理 lexical path、realpath、父目录 realpath、symlink 与 skipped path 校验，避免读写工具路径策略漂移。
- 新增读状态：`FileReadStateStore` 记录 `read_file` 读取到的内容、mtime、size、sha256 与截断状态；`read_file`、`search_files`、`edit_file` / `write_file` 和 `diagnose_file` 严格拒绝非法 UTF-8 文本，避免替换字符污染后续写入；`edit_file` / `write_file` 对现有文件要求先完整读取，且写前确认文件未被外部修改。
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
- `apply_patch` 先解析并 dry-run 所有文件，要求更新现有文件前已通过 `read_file` 建立新鲜读状态；任一 hunk 不匹配、路径越界或目标不合法时，整批 patch 不写入任何文件；补丁中的 `\ No newline at end of file` 标记会参与匹配和输出，避免误改文件末尾换行状态。
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
- `diagnose_workspace` 在 workspace 内优先运行 `npm run typecheck`；如果 package.json 没有 `scripts.typecheck`，fallback 到 `npx --no-install tsc --noEmit`，避免诊断工具隐式安装依赖。
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

- 扩展 `src/shared/agent-contracts.ts`：新增 `ThreadRecord / ThreadSummary / ThreadRelation / TurnRecord / TurnStatus`、9 种 `Item`（`user | assistant | reasoning | tool | compaction | approval | user_input | plan | system`）、9 种 `RuntimeEvent`、IPC `Request / Response` 类型、`IpcResult<T>` 通用包壳 + `isItem / isRuntimeEvent / isThreadRecord` 类型守卫（替代 zod）。
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
- 新建 `src/renderer/src/ui/store/WorkbenchContext.tsx`：`useReducer` 模拟 store，state 包含 `route / activeThreadId / threads / items / inFlightTurnsByThreadId / rightPanelMode / composer / leftSidebarWidth / rightSidebarWidth / basicPreferences`。
- 新建基础 primitive；当前保留并使用的是 `Pill`，早期未接入调用方的 `IconButton / Chip / KbdHint` 已清理。
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
- 设置页“基础设置”扩展为“外观与语言 / 启动与布局 / 会话与工作区”三组：支持界面语言、界面主题、跟随系统主题、默认启动视图、记住左右面板宽度、默认 Inspector 面板、默认显示归档会话和启动时恢复上次工作区。
- `WorkbenchContext` 从基础偏好派生初始 route、workspaceRoot、归档显示、Inspector 面板和左右宽度；设置页修改偏好后会即时同步到工作台状态。
- 侧栏删除会话始终显示 inline 二次确认；写作工作台补充返回编码工作台和进入设置页的导航，避免默认启动写作视图后缺少返回路径。
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
- 加固 `write.get` 文本边界：Markdown 读取改为严格 UTF-8 校验，非法字节通过 `WRITE_GET_FAILED` 暴露，不再以替换字符进入编辑器状态。
- 完善 Write 模式基础交互：文件列表支持搜索过滤，编辑器按 800ms debounce 自动保存，`write.complete` 提供本地 Markdown 列表/引用续写建议，渲染端支持 650ms completion debounce、Tab 接受与 Escape 取消。
- 修复 Write 模式文件服务职责边界：`write.get` / `write.put` / `write.complete` 现在和 `write.list` 一样只接受 `.md`、`.mdx`、`.markdown`，避免绕过 Markdown 文件列表读写任意 UTF-8 文件。
- 修复 Write 模式自动保存竞态：同一文件保存请求串行化，保存中继续编辑会在前一轮完成后再写入最新内容，避免旧请求晚返回覆盖新内容。
- 修复 Write 模式文件切换丢改动风险：打开其他文件或刷新/切换工作区前会先 flush 当前脏文件；保存失败时停留当前文件并展示错误。
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
- 优化大模型输出 Markdown 渲染：`AssistantMarkdown` 继续使用 `react-markdown` + `remark-gfm`，但新增链接、代码块、表格、任务列表、图片和分隔线的稳定容器/样式映射，长代码和宽表格在中心内容列内横向滚动，外链打开新窗口；流式未闭合三反引号代码围栏会在渲染层临时闭合，链接和图片地址会按 renderer/main 一致的安全边界规范化，不安全协议降级为纯文本或不渲染图片。
- 优化代码块交互：Assistant Markdown 代码块顶部栏显示语言或默认代码标签，并提供复制按钮；剪贴板不可用或写入失败时显示失败反馈，不影响消息渲染。
- 优化流式输出滚动：`MessageTimeline` 在用户停留于底部附近时自动跟随最新 `item_updated` / `item_appended` 内容；用户上滑阅读旧内容后停止抢滚动，回到底部后恢复跟随。
- 优化工作过程展开状态：`MessageTimeline` 仍默认展开当前运行 turn 的 work process，但会按 turnId 保留用户手动展开/折叠选择，避免流式更新时重置阅读状态。
- 优化线程侧栏交互：删除会话从系统 `window.confirm` 改为行内确认态，线程主区域改为真实 button，归档/恢复/删除操作独立成 action 区，减少误触并提升键盘焦点可见性。
- 优化 Write 工作台交互：文件列表增加加载、未打开工作区、无 Markdown 文件和搜索无结果状态；文件行改为真实 button 并显示大小/日期元信息；搜索框支持一键清空；保存按钮在无文件、无变更或忙碌状态下禁用并显示已保存状态。
- 优化工作台基础可控性：左侧分栏 separator 支持键盘焦点、可访问名称、Arrow/Home/End 调宽、双击恢复默认宽度，并复用鼠标拖拽宽度边界；聊天错误提示改为可关闭 toast，不再只能等待下一次状态覆盖。
- 优化 RightInspector 交互：右侧分析面板增加左边缘 resizer，支持可访问名称、鼠标拖拽、双击恢复默认宽度与 Arrow/Home/End 键盘调宽，宽度范围遵循 `docs/ui-design.md` 的 280 到 760；检查器空状态和变更列表样式从内联样式收敛到 `shell.css`。
- 优化 RightInspector 分析内容：Changes 面板复用工具摘要展示工具标题、状态和参数/结果详情；Todo 面板从待审批、失败工具、运行错误与最新计划未完成步骤派生可操作事项；Plan 面板显示最新计划进度与步骤状态。
- 优化 approval 交互：审批按钮点击后进入本地提交中状态并禁用 allow/deny，避免 IPC 返回或事件更新前重复提交；approval 参数 JSON 使用固定样式与滚动区域展示。
- 优化 Settings 模型档案交互：删除 profile 改为卡片内行内确认态，提供确认/取消和删除中反馈，避免单击误删模型配置。
- 加固 Settings 未保存修改保护：模型档案表单处于 dirty 状态时会阻止激活、创建、复制、删除 profile 和返回工作台，并显示保存提示；保存按钮在 idle/saved/loading/saving 时禁用，避免无变更保存。
- 修复 Settings profile 加载依赖：模型档案只在设置页挂载时从 `modelConfig.listProfiles()` 初始加载，不随语言/主题等基础偏好切换重拉，避免覆盖当前未保存的模型表单。
- 扩展 Settings 基础设置：新增“基础设置”大类，并完整提供“外观与语言 / 启动与布局 / 会话与工作区”三组偏好；这些偏好选择后立即生效并保存到渲染端 localStorage，不复用大模型配置保存状态。
- 修复附件存储输入校验：`AttachmentStore` 现在严格校验 `dataBase64`，非法 base64 不会被 `Buffer.from(..., "base64")` 宽松解码后保存为损坏附件。
- 修复附件创建失败副产物：`AttachmentStore.create()` 在附件二进制写入后如果索引更新失败，会删除刚创建的 `.bin` 文件并原样抛出错误，避免留下孤儿附件。
- 修复 composer 附件删除竞态：发送中或当前 active thread 运行中会禁用附件删除，避免用户在 runtime 读取附件前删除 blob 导致 turn 读取缺失。
- 优化 composer 图片交互：对话框支持从剪贴板直接粘贴 PNG/JPEG/WebP/GIF 图片，图片会在 renderer 生成 bounded thumbnail data URL 并在 composer 内以缩略图展示；缩略图右上角悬浮删除按钮和空输入框 Backspace/Delete 都会走同一条附件删除 IPC，发送中或 active turn 运行中继续禁用删除。
- 修复 composer 附件可见状态脱节：`WorkbenchContext` 的 composer state 同时保存 `attachmentIds` 与缩略图展示记录，避免路由/组件重挂载后仍有待发送附件 id 但 UI 无法显示和删除。
- 优化 Sidebar 底部工作台切换：原先只显示当前 `编码/写作` 状态的 footer 标签改为 Code/Write 快速切换控件，复用已有 `WorkbenchContext.actions.setRoute("code" | "write")`，设置入口继续保持独立按钮。
- 加固本地持久化 ID 边界：`JsonlThreadStore` 和 `AttachmentStore` 在解析 thread / attachment 本地路径前校验 UUID，阻止 renderer 或损坏数据传入 `../` 之类路径片段访问、写入或删除持久化目录外文件。
- 加固线程持久化输入校验：`JsonlThreadStore.createThread/listThreads/updateThread` 现在会在写入或过滤前校验 workspace、mode、relation、status、approvalPolicy、sandboxMode、goal 等运行时输入，避免坏 IPC 数据写入 index/thread JSON。
- 修复线程创建失败副产物：`JsonlThreadStore.createThread()` 在新线程目录和 JSONL 文件创建后，如果索引写入失败，会删除本次新建线程目录并原样抛出错误，避免留下未索引线程数据。
- 加固 workspace 工具符号链接边界：`list_files` 和 `search_files` 会跳过符号链接条目，避免通过工作区内 symlink 暴露或遍历工作区外内容；`read_file` 继续使用 realpath 校验阻止 symlink 文件读取越界。
- 修复 OpenAI-compatible 流式工具调用收尾：provider 以 `stop` 或 `[DONE]` 结束但已发送完整 tool call delta 时，`MiniMaxGateway` 会 flush pending tool call，避免 runtime 静默丢失工具调用。
- 修复 OpenAI-compatible 流式 usage 收尾：`MiniMaxGateway` 不再在 terminal `finish_reason` 后提前停止读取 SSE，会继续读到 `[DONE]` 或 stream close，避免 provider 单独发送的 usage-only 尾帧丢失。
- 修复 Anthropic-compatible 流式 usage 收尾：`MiniMaxGateway` 不再在 `message_delta.stop_reason` 后提前停止读取 SSE，会继续读到 `[DONE]` 或 stream close，避免兼容服务单独发送的 usage-only 尾帧丢失。
- 修复 Anthropic-compatible 流式工具调用收尾：兼容服务缺少 `content_block_stop` 但以 `message_delta` / `[DONE]` 结束时，`MiniMaxGateway` 会 flush 已累积的 pending tool call。
- 修复 LLM SSE reader 清理可追踪性：释放 SSE reader lock 失败时会记录带上下文的 warning，不再使用静默空 catch 分支。
- 修复工具注册边界：`InMemoryToolRegistry.register()` 现在拒绝重复工具名，避免组合根或测试接线错误被后注册工具静默覆盖。
- 加固 `update_goal` 目标机制：工具清除目标改为显式 `clear: true`，空字符串或非字符串 `goal` 不再被静默解释为清除；归档线程拒绝 goal 更新；`complete` / `blocked` 时间戳只在首次进入对应终态时写入，后续编辑 summary 或文本不会刷新终态时间；renderer 仅处理当前 active thread 的 `goal_updated` 事件。
- 优化 workspace 搜索工具容错：`search_files` 的 `path` 现在既可指向目录，也可指向单个 UTF-8 文本文件；单文件路径会只搜索该文件，避免模型把文件路径传给搜索工具时反复得到 `path is not a directory` 并触发工具轮数上限。
- 优化 AgentRuntime 自动工具预算：固定 6 轮硬限制升级为模型档案 `agent_autonomy` 三档策略（保守 12、平衡 32、深度 64），仍可通过 `AGENT_MAX_TOOL_ROUNDS` 覆盖；运行时会在预算后段提示模型收敛或避免重复失败工具，预算耗尽时会把最后一批未执行 tool call 记录为 failed tool result，发出 `tool_budget_reached`，并以 `needs_continuation` 结束当前 turn。
- 修复 `apply_patch` 执行阶段部分提交风险：多文件 patch 在全部 hunk dry-run 后写入；若后续文件写入失败，会按本次已提交文件逆序恢复原内容/删除新建文件，且失败 patch 不写入 file history。
- 修复 `apply_patch` 重复文件段边界：同一个 patch 内重复出现同一 resolved target 会被拒绝；同一文件的多段修改必须放在一个文件头下的多个 hunk，避免成功路径覆盖早先段落或失败回滚恢复到中间状态。
- 修复 `apply_patch` hunk 解析边界：hunk 内删除的原文如果本身以 `--` 开头，diff 行会以 `---` 开头；parser 现在只有在 `---` 后紧跟 `+++` 文件头时才切换文件段，避免把合法删除行误判为新文件头。
- 修复 Workbench SSE 订阅生命周期：删除或归档曾经打开过但当前不 active 的线程时，也会释放 renderer 保留的 thread subscription，避免后台事件订阅长期残留。
- 修复 `diagnose_workspace` 子项目路径解析：当工具在 workspace 子目录 cwd 中运行 typecheck 时，TypeScript 相对诊断路径会从实际命令 cwd 解析，再转换为 workspace-relative 路径，避免 monorepo 子包错误被误报到根目录。
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
- 修复渲染端 last workspace 偏好边界：`agent-pyramid.lastWorkspaceRoot` 读取时会 trim，空白脏数据会被视为无工作区，避免启动恢复后绕过目录选择并把无效 workspace 传给 IPC。
- 清理工具 schema 旧参数：`diagnose_file` 只使用 TypeScript Language Service 对单文件诊断，工具定义不再暴露未实现的 `cwd` / `timeout_ms`。
- 清理 renderer 旧状态逻辑：删除无调用方的 `resetItems` reducer action，并移除 `Workbench` 中不可达的空 route 兼容判断。
- 加固 JSONL replay 边界：`JsonlThreadStore.replayItems()` / `replayEvents()` 会在 JSON parse 后使用 shared contract guard 校验最小形状，解析成功但缺少必需字段的坏记录会 warning 并跳过，不再进入 runtime 或 renderer。
- 清理 SSE handler 死分支：删除注册时扫描既有 `BrowserWindow` 的空跑 cleanup，SSE 订阅继续在实际 `event.sender` 订阅创建时绑定 destroyed cleanup。
- 修复 SSE 订阅 id 规范化：`sse:subscribe` / `sse:unsubscribe` 现在都会 trim `threadId` 后再作为订阅 key，避免带空白订阅后无法用规范 id 退订。
- 修复 workspace picker 异常成功：Electron 目录选择器若返回未取消但没有路径，现在通过 `WORKSPACE_PICK_DIRECTORY_FAILED` 暴露错误，不再返回 `ok({ canceled:false,path:null })`。
- 加固 goal 更新入口：`AgentRuntime.updateThreadGoal()` 复用 shared contract 的 `isThreadGoalStatus()` 校验状态，非法 status 会明确失败，避免 IPC 或内部调用绕过工具输入校验写入坏 goal 状态。
- 加固 goal IPC 边界：`goals.update` 现在先解析未知 renderer payload，`clear` 必须是 boolean 且只有 `true` 会清除目标，避免 `"false"` 等 truthy 畸形值被误解释为清除。
- 加固模型 profile 创建边界：`modelConfig.createProfile` IPC 和 `ModelConfigStore.createProfile()` 服务层现在都会拒绝非 boolean `activate`，避免 `"false"` 等 truthy 畸形值激活新 profile。
- 加固 turn start 边界：`AgentRuntime.startTurn()` 现在会在写入 item / turn 前校验公开请求字段形状，包括 `text`、`mode`、`reasoningEffort`、`attachmentIds` 和 `goalMode`；shared runtime event guard 也会拒绝 `turn_started.turn.goalMode` 的坏形状，避免畸形 IPC payload 污染持久化或改变工具暴露逻辑。
- 加固 thread list 过滤边界：`JsonlThreadStore.listThreads()` 现在要求 `includeArchived` / `archivedOnly` 是 boolean，避免 `"false"` 等 truthy 畸形值返回误导性的归档线程结果。
- 加固线程持久化读取边界：`JsonlThreadStore.getThread()` / `listThreads()` 现在会校验 persisted thread/index 的 UUID、workspace、status、relation、approvalPolicy、sandboxMode 和 goal 形状；`relation: "fork"` 必须带 `parentThreadId`，旧记录缺失的安全默认值继续单向补齐，坏值会明确失败，不再进入 runtime 策略判断。
- 加固 thread create 谱系边界：`thread:create` 现在拒绝没有 `parentThreadId` 的 `relation: "fork"` payload，普通 fork 创建继续通过专用 `thread:fork` channel 进入 `JsonlThreadStore.forkThread()`。
- 加固 approval preview 契约：shared contract guard 和 `AgentRuntime` 本地 preview 过滤现在会校验 diff preview 的文件、行、操作与非负整数计数形状，畸形工具预览不会进入 approval item / event。
- 收敛 thread 字段枚举与默认机制来源：`relation`、`mode`、`status`、`approvalPolicy`、`sandboxMode` 和 goal status 的允许值统一由 `src/shared/agent-contracts.ts` 的 `THREAD_*` 常量与 guard 提供；创建线程、legacy 归一化和默认 list 关系过滤复用同文件的 `DEFAULT_THREAD_*` 常量，IPC 解析和持久化归一化不再各自维护重复字面量集合。
- 收敛 item/runtime event kind 契约：`ITEM_KINDS`、`RUNTIME_EVENT_KINDS`、`isItemKind()` 和 `isRuntimeEventKind()` 现在由 shared contract 导出并带类型级一致性断言；`RuntimeEventBus.onThread()` 复用 `RUNTIME_EVENT_KINDS`，新增 runtime event 不再需要维护第二份 bus 订阅列表。
- 加固 runtime event 嵌套一致性：shared `isRuntimeEvent()` 现在要求 `turn_started` 顶层 `threadId/turnId/startedAt` 与嵌套 `turn.threadId/id/startedAt` 一致，并要求 `item_appended/item_updated` 顶层 `threadId/turnId` 与嵌套 `item.threadId/turnId` 一致，避免矛盾事件通过 event bus / SSE 按错误线程投递。
- 收敛 tool access policy mode 来源：`createToolAccessPolicy()` 的冲突检测现在遍历 shared `THREAD_MODES`，不再在 runtime 内维护第二份 `code/write` mode 字面量列表。
- 加固附件元数据契约：shared contract 现在导出 `isAttachmentRecord()`，`UserItem.attachments` 的 replay guard 和 `AttachmentStore` index 读取共同使用同一 metadata 校验，畸形 MIME / size 的附件元数据不会进入 runtime 或 renderer。
- 收敛 UUID 校验边界：shared contract 现在导出 `UUID_PATTERN` / `isUuidString()`，线程与附件持久化路径解析、附件 metadata guard 共用同一 UUID 判断，避免 id 安全边界在多个 store 内重复漂移。
- 加固 JSONL 写入边界：`JsonlThreadStore.appendItem()` / `appendEvent()` 现在会在写入前复用 shared `isItem()` / `isRuntimeEvent()` 并校验 record `threadId` 与目标线程一致，避免坏记录先写入成功再在 replay 阶段被跳过。
- 加固 JSONL 所有权边界：`JsonlThreadStore.replayItems()` / `replayEvents()` 现在会跳过有效形状但 `threadId` 不属于目标线程的历史行；`appendEvent()` 同步校验 `turn_started.turn` 与 `item_appended/item_updated.item` 的嵌套 `threadId`，避免跨线程嵌套记录写入或重放。
- 收敛 ISO 时间戳契约：shared contract 现在导出 `ISO_TIMESTAMP_PATTERN` / `isIsoTimestampString()`，`Item.createdAt`、`RuntimeEvent` 时间字段、`TurnRecord`、`ThreadGoal` 和 `AttachmentRecord.createdAt` 复用同一 `Date.prototype.toISOString()` 边界，避免坏时间字符串进入 JSONL、usage 聚合或 renderer 排序。
- 加固 thread/index 时间读取边界：`JsonlThreadStore` 现在在读取 `thread.json` / `index.json` 时用 shared ISO timestamp 守卫校验 `createdAt`、`updatedAt`、`forkedAt` 和 goal 时间字段，避免损坏数据通过 `Date.parse()` 变成不稳定排序或活动时间比较。
- 收敛模型配置 profile 时间边界：`ModelConfigStore` 读取 profiles 状态时会用 shared ISO timestamp 守卫归一化 `createdAt` / `updatedAt`，缺失或损坏的 legacy 时间会替换为当前 ISO 时间，不再把坏字符串传给设置页或后续持久化。
- 落地 runtime preferences 主进程链路：新增 shared `RuntimePreferences` 契约、`RuntimePreferencesStore`、`runtime-preferences:get/update` IPC 与 preload API；`AgentRuntime` 现在使用 thread-mode 默认 profile，并把 `toolAvailability` 接入工具 definitions 过滤和 forced tool call 拦截；新建 thread 会读取默认 approval/sandbox，命令工具读取 timeout/output limit，上下文准备读取 compaction enablement/strategy，renderer 读取 approval presentation 偏好，避免设置保存后无运行时或 UI 效果。
- 验证方式：`npm run typecheck`、`npm run test`、`npm run build`。

### 2026-06-09 - Shared config-backed Agent controls

- Moved Agent runtime preferences into the shared Electron `userData/config` file as `runtimePreferences`, alongside `activeProfileId` and `profiles[]`.
- Added a shared config-file persistence boundary so `ModelConfigStore` and `RuntimePreferencesStore` serialize writes through the same queue; profile updates preserve Agent controls, and runtime preference updates preserve model profiles.
- Kept the existing `runtime-preferences:get/update` IPC and preload API as the typed access surface for Agent controls. Legacy `userData/runtime-preferences.json` is read only when the shared config lacks a `runtimePreferences` section; `config.runtimePreferences` wins if both exist.
- Verification coverage: model config and runtime preferences persistence tests cover default initialization, legacy preference migration, config-vs-legacy priority, and concurrent shared-config writes.

### 2026-06-09 - LLM streaming usage and interrupt lifecycle hardening
- Hardened Anthropic-compatible usage mapping: `cache_read_input_tokens` and `cache_creation_input_tokens` now populate `TokenUsage.cacheHitTokens`, `cacheMissTokens`, and `cacheHitRate`; streaming usage from `message_start` and `message_delta` frames is merged before it reaches the runtime, so partial provider usage frames do not overwrite previously observed fields.
- Hardened streaming turn cleanup: interrupted turns remain in `AgentRuntime` in-flight state until the background run loop persists truncated partial output/tool cleanup and emits `turn_completed(status: "interrupted")`; non-interrupt worker failures after text/reasoning deltas now persist the truncated assistant/reasoning output before `turn_failed`.
- Hardened MessageTimeline visibility: disabling read-only tool process records now hides only non-failed read-only records. Failed read-only tools remain visible in the timeline so runtime/tool errors are not masked by presentation preferences.
- Hardened worker cancellation: `LlmWorkerPool` request cleanup only clears the cancel handle installed by that request, preventing late old-request cleanup from deleting a newer same-thread cancel mapping.
- Hardened worker diagnostics: worker protocol errors now preserve `http` / `provider` / `schema` / `internal` through `LlmWorkerPool`, `AgentRuntime` maps them to `provider_http` / `provider_error` / `schema_invalid` / `internal`, worker exit/error maps to `worker_crashed`, and worker `LlmResponse.raw` is now a bounded stream summary instead of an unbounded full chunk transcript.
- Hardened provider SSE error handling: OpenAI-compatible and Anthropic-compatible `event: error` frames now throw a traceable provider stream error instead of being consumed as empty normal payloads.
- Current model profile protocol behavior: `AgentRuntime` forwards the selected profile `protocol` into `LlmRequest`; OpenAI-compatible and Anthropic-compatible profiles share the same runtime path while `MiniMaxGateway` owns provider-specific body and SSE mapping.
- Verification: `npm test -- tests/main/infrastructure/minimax-types.test.ts tests/main/infrastructure/minimax-gateway.test.ts`, `npm test -- tests/main/application/agent-runtime.test.ts tests/main/infrastructure/worker-pool.test.ts`, `npm test -- tests/main/infrastructure/worker-diagnostics.test.ts tests/main/infrastructure/worker-pool.test.ts tests/main/application/agent-runtime.test.ts tests/shared/agent-contracts.test.ts`; full `typecheck/test/build` verification is run before handoff.

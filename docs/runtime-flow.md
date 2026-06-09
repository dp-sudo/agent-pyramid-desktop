# Runtime Flow

本文说明当前 Agent turn 的真实运行链路、状态转换、事件流、工具循环、中断和失败路径。它用于帮助 Agent 修改 runtime 时先理解机制边界，避免只改同步调用而遗漏异步事件、持久化或 UI 状态。

## Scope

权威源码：

- `src/main/application/agent-runtime.ts`
- `src/main/domain/agent/types.ts`
- `src/main/domain/agent/ports.ts`
- `src/main/infrastructure/llm-worker/*`
- `src/main/infrastructure/minimax/minimax-gateway.ts`
- `src/main/event-bus.ts`
- `src/main/ipc/turns-handlers.ts`
- `src/main/ipc/sse-handlers.ts`
- `src/renderer/src/ui/Workbench.tsx`
- `src/renderer/src/ui/store/WorkbenchContext.tsx`

非目标：

- 本文不定义新的 runtime 行为。
- 本文不描述外部参考项目。
- Provider HTTP 细节只保留 runtime 相关概览，详细协议见 `docs/minimax/` 和 gateway 代码。

## Runtime Actors

```mermaid
flowchart LR
  Renderer["Renderer Workbench"]
  Preload["window.agentApi"]
  TurnHandler["turns-handlers.ts"]
  Runtime["AgentRuntime"]
  Store["JsonlThreadStore"]
  Attachments["AttachmentStore"]
  Config["ModelConfigStore"]
  Preferences["RuntimePreferencesStore\nconfig-backed"]
  Registry["ToolRegistry"]
  Bus["RuntimeEventBus"]
  Pool["LlmWorkerPool"]
  Worker["llm-worker"]
  Gateway["MiniMaxGateway"]
  Provider["Model Provider"]

  Renderer --> Preload
  Preload --> TurnHandler
  TurnHandler --> Runtime
  Runtime --> Store
  Runtime --> Attachments
  Runtime --> Config
  Runtime --> Preferences
  Runtime --> Registry
  Runtime --> Pool
  Runtime --> Bus
  Pool --> Worker
  Worker --> Gateway
  Gateway --> Provider
  Bus -. "RuntimeEvent" .-> Renderer
```

`AgentRuntime` owns the turn state machine. IPC handlers only call it and package results into `IpcResult<T>`.

## Turn Start Sequence

```mermaid
sequenceDiagram
  participant UI as Workbench
  participant API as window.agentApi
  participant IPC as turns-handlers
  participant RT as AgentRuntime
  participant Store as JsonlThreadStore
  participant Config as ModelConfigStore
  participant Prefs as RuntimePreferencesStore
  participant Att as AttachmentStore
  participant Bus as RuntimeEventBus

  UI->>API: turns.start(TurnStartRequest)
  API->>IPC: ipcRenderer.invoke("turn:start", request)
  IPC->>RT: startTurn(request)
  RT->>Store: getThread(threadId)
  RT->>Config: listProfiles()
  RT->>Prefs: get()
  RT->>Att: get(attachmentIds)
  RT->>Store: appendItem(UserItem)
  RT->>Bus: item_appended(UserItem)
  RT->>Bus: turn_started(TurnRecord)
  RT-->>IPC: TurnRecord(status="in-flight")
  IPC-->>API: ok(TurnRecord)
  API-->>UI: IpcResult<TurnRecord>
  RT-)RT: runTurn(...) in background
```

Important behavior:

- `turns.start()` does not wait for the LLM response to finish.
- The synchronous return is an in-flight `TurnRecord`.
- The visible timeline receives the user item through `item_appended`; the
  persisted thread/index `updatedAt` is advanced by the item timestamp.
- Later assistant text, reasoning, tools, completion and failure arrive through runtime events.

## Start Preconditions

`AgentRuntime.startTurn()` checks:

- Thread exists via `JsonlThreadStore.getThread()`.
- Thread is not archived.
- Same thread does not already have an in-flight turn.
- Requested `modelProfileId`, when present, exists.
- Runtime preferences are readable; if no store is configured, runtime falls
  back to `DEFAULT_RUNTIME_PREFERENCES`. The configured store reads the
  `runtimePreferences` section from `userData/config`.
- Attachment ids, when present, resolve through `AttachmentStore.get()`.

Failure mapping:

- Same-thread concurrency throws `RUNTIME_TURN_BUSY`; `turns-handlers.ts` maps it to IPC error code `RUNTIME_TURN_BUSY`.
- Other start failures are returned as `TURN_START_FAILED`.
- Archived thread currently throws `RUNTIME_THREAD_ARCHIVED`; IPC maps it to `TURN_START_FAILED` with that message.
- `AgentRuntime.startTurn()` validates public request field shapes before model
  profile resolution or item append: `text` must be string, `mode` must be
  `agent | plan`, `reasoningEffort` must be a supported effort,
  `attachmentIds` must be `string[]`, and `goalMode` must be boolean.

## Turn Record Construction

The created `TurnRecord` contains:

- `id`: generated UUID.
- `threadId`: request thread id.
- `status`: `"in-flight"`.
- `startedAt`: ISO timestamp.
- `model`: resolved selected profile model.
- `reasoningEffort`: request override or selected profile default.
- `modelProfileId`: selected profile id.
- `mode`: request mode or `"agent"`.
- `goalMode`: request goal mode or active thread goal state.

Shared runtime event replay requires `startedAt`, `completedAt`, `failedAt`,
and tool-budget `reachedAt` values to match `Date.prototype.toISOString()`.

Model profile resolution order:

1. Explicit `request.modelProfileId`.
2. Thread-mode default profile from `RuntimePreferences`
   (`codeDefaultModelProfileId` / `writeDefaultModelProfileId`) when it matches
   an existing profile. These defaults are stored in `userData/config` beside
   the model profiles they reference.
3. `request.model` matching a profile config model.
4. Active profile id.
5. First available profile.

## Background Run Loop

After the user item is persisted, `AgentRuntime.runTurn()` builds the model messages and executes the LLM/tool loop.

```mermaid
flowchart TD
  Start["runTurn"]
  History["collectHistory(thread, exclude current turn)"]
  Context["buildRuntimeContextMessages(plan/goal)"]
  User["buildUserContent(text + attachments)"]
  Loop["for round <= maxToolRounds"]
  BuildReq["buildLlmRequest"]
  Compact["prepareMessagesForRequest"]
  Chat["LlmWorkerPool.chat"]
  Stream["applyStreamChunk -> item_updated"]
  Persist["persistModelOutput -> item_appended"]
  ToolCheck{"response.toolCalls.length > 0?"}
  Budget{"round >= maxToolRounds?"}
  Execute["executeToolCall"]
  PushTool["push assistant tool call + tool result into messages"]
  Complete["markTurnStatus(completed)"]
  NeedsContinuation["append budget warning\nmark needs_continuation"]
  Failed["mark failed / emit runtime_error"]

  Start --> History --> Context --> User --> Loop
  Loop --> BuildReq --> Compact --> Chat --> Stream --> Persist --> ToolCheck
  ToolCheck -- "no" --> Complete
  ToolCheck -- "yes" --> Budget
  Budget -- "yes" --> NeedsContinuation
  Budget -- "no" --> Execute --> PushTool --> Loop
  Chat -- "throws" --> Failed
```

Runtime context placement:

- Base `SYSTEM_PROMPT` stays stable.
- Plan and goal instructions are runtime context messages, not merged into the base prompt.
- User attachments become `AgentContentBlock[]` in `AgentMessage.content`.

LLM request construction:

- `LlmRequest.protocol` comes from the selected `ModelConfig.protocol`.
  `openai-compatible` and `anthropic-compatible` share the same runtime loop;
  `MiniMaxGateway` owns request body and SSE parsing differences.
- Tool definitions are filtered by turn mode, goal/plan mode and
  `RuntimePreferences.toolAvailability` before they are passed to
  `prepareMessagesForRequest()` and the worker pool.
- Context budget inputs still come from the selected model profile
  (`model_context_window`, `model_auto_compact_token_limit`, `max_tokens`),
  while automatic compaction enablement and strategy come from
  config-backed `RuntimePreferences.compaction`.
- When automatic compaction is disabled, runtime skips summary compaction but
  still applies the hard context safety limit before calling the worker.

## Streaming Semantics

Worker stream chunks are represented by `LlmStreamChunk` in `src/main/domain/agent/types.ts`.

Runtime currently reacts to:

- `text_delta`: lazily creates or updates a live `AssistantItem`, then emits `item_updated`.
- `reasoning_delta`: lazily creates or updates a live `ReasoningItem`, then emits `item_updated`.
- `usage`: updates `turn.usage`.

Final persistence:

- Reasoning and assistant live items are appended to `messages.jsonl` when the
  stream completes, is interrupted, or fails after partial deltas.
- Interrupted and failed partial assistant output is persisted with
  `truncated: true` before the terminal lifecycle event is emitted.
- The same item id may appear more than once in JSONL because updates are append-only.
- Renderer and `turns.get` dedupe by item id, keeping the latest item version.

## Worker Flow

```mermaid
sequenceDiagram
  participant RT as AgentRuntime
  participant Pool as LlmWorkerPool
  participant Worker as llm-worker
  participant Gateway as MiniMaxGateway
  participant Provider as Provider HTTP API

  RT->>Pool: chat({ id: thread.id }, LlmRequest, onChunk)
  Pool->>Worker: { type: "chat", requestId, payload }
  Worker->>Gateway: stream(request, { signal })
  Gateway->>Provider: fetch SSE request
  Provider-->>Gateway: SSE chunks
  Gateway-->>Worker: LlmStreamChunk
  Worker-->>Pool: { kind: "delta", requestId, chunk }
  Pool-->>RT: onChunk(chunk)
  Gateway-->>Worker: completed final response
  Worker-->>Pool: { kind: "done", requestId, response }
  Pool-->>RT: LlmResponse
```

Worker invariants:

- Same `threadId` maps to the same worker entry while the worker is alive.
- `AgentRuntime` enforces same-thread in-flight gating.
- `LlmWorkerPool.cancel(threadId)` posts a cancel message for the active request.
- A worker request cleanup only clears the cancel handle it installed; this
  protects newer same-thread requests if an old request settles late.
- Worker replacement clears thread affinity for dead workers.
- Worker errors preserve protocol categories through the pool: provider HTTP
  failures become `provider_http`, provider SSE `event: error` frames become
  `provider_error`, provider/schema parse failures become `schema_invalid`,
  and worker process failures become `worker_crashed`.
- Worker `LlmResponse.raw` is a bounded stream summary rather than a full chunk
  transcript, so long text/reasoning/tool streams do not duplicate unbounded
  content in memory.

## Tool Loop

Tool definitions come from `ToolRegistry.listDefinitions()` and are filtered by turn context before being sent to the model.

```mermaid
flowchart TD
  Response["LlmResponse.toolCalls"]
  Available{"Tool available\nfor this turn?"}
  Approval{"Requires approval?"}
  RequestApproval["append ApprovalItem\nemit approval_requested"]
  Decision{"allow?"}
  Execute["ToolRegistry.execute(call, context)"]
  Complete["ToolItem completed\nemit item_updated"]
  Fail["ToolItem failed\nemit runtime_error when appropriate"]
  Plan{"call.name == create_plan?"}
  AppendPlan["append PlanItem"]
  ReturnResult["Return AgentToolResult to model messages"]

  Response --> Available
  Available -- "no" --> Fail --> ReturnResult
  Available -- "yes" --> Approval
  Approval -- "yes" --> RequestApproval --> Decision
  Decision -- "deny" --> Fail --> ReturnResult
  Decision -- "allow" --> Execute
  Approval -- "no" --> Execute
  Execute --> Complete --> Plan
  Execute -- "throws" --> Fail
  Plan -- "yes" --> AppendPlan --> ReturnResult
  Plan -- "no" --> ReturnResult
```

Tool availability:

- `create_plan` is only enabled when `turn.mode === "plan"`.
- `update_goal` is enabled when `turn.goalMode` is true or the thread has an active goal.
- Other registered tools pass through `AgentRuntime` tool access policy and
  persisted `RuntimePreferences.toolAvailability` before they are sent to the
  model or executed from a forced model tool call.
- The default tool access policy denies Code-only tools in Write threads:
  `edit_file`, `write_file`, `apply_patch`, `rollback_file`, `run_command`,
  `diagnose_workspace`, and `diagnose_file`.
- Tool access policy is catalog-level control. It can be configured per thread
  mode to allow or deny individual tool names without changing persisted thread
  data. Approval and sandbox checks still run afterward.
- `RuntimePreferences.toolAvailability` is the main-process persisted catalog
  switch for known runtime tools, stored in `userData/config`. Disabled tools are omitted from
  `LlmRequest.tools`; if the model still returns a disabled tool call, runtime
  appends a failed `ToolItem` and emits `runtime_error(code: "tool_not_found")`.
- Constructor-injected `toolAccessPolicy` remains the highest-priority override
  for tests and composition-root policy, then persisted runtime preferences
  apply to known runtime tool names, then the default policy applies.

Approval policy currently implemented in runtime:

- Tools marked `metadata.isReadOnly` skip approval.
- Enabled `create_plan` and `update_goal` skip approval.
- `sandboxMode: "read-only"` denies non-read-only tools before execution.
- `approvalPolicy: "never"` denies non-read-only tools before execution.
- `approvalPolicy: "auto"` allows tools whose metadata sets `isDestructive: false`; shell-backed command tools must not use this bypass.
- All remaining non-read-only tools require approval.

Workspace tools require an absolute thread workspace path before resolving file paths. `read_file`, `search_files`, `edit_file`, `write_file`, `apply_patch`, and `diagnose_file` operate on strict UTF-8 text and reject invalid byte sequences instead of replacing them. `edit_file`, `write_file`, `apply_patch`, and `rollback_file` are destructive workspace tools, so they request approval and can include structured diff previews. Before writing or deleting, coding tools re-check the workspace path policy and current file content so an external change between dry-run and commit cannot be overwritten silently. `apply_patch` returns a `multi_file_diff` preview when the patch touches more than one file, validates every hunk before writing, preserves `\ No newline at end of file` markers, and restores files already written in the same patch if a later write fails. `rollback_file` uses the current runtime's in-memory file history and refuses to run if the file no longer matches the latest agent-written content. `run_command` is also treated as destructive because arbitrary shell commands can modify files or run workspace scripts; it requests approval even when `approvalPolicy: "auto"` is set.

`apply_patch` applies a restricted unified diff format for UTF-8 create/update hunks. Runtime preview and execution both perform a dry-run first; if any file hunk cannot be applied, no file is written. A patch may include multiple hunks for one file under a single file header, but duplicate file sections for the same resolved target are rejected so successful writes and failure rollback both have one authoritative pre-write snapshot per file. The parser treats `\ No newline at end of file` as part of the neighboring hunk line, so patches cannot silently add or remove the final newline. Existing lines keep their original LF or CRLF endings; added lines use the local file ending around the insertion point, falling back to LF for new files.

File history is currently held in memory by `AgentRuntime`. It covers writes made in the current app process by `edit_file`, `write_file`, `apply_patch`, and `rollback_file`; it is not replayed from JSONL after restart.

`run_command` executes foreground shell commands inside the active workspace only. Its `cwd` is workspace-relative and goes through the shared realpath/path escape policy. Runtime injects config-backed `RuntimePreferences.command` as the default timeout and output limit; stricter tool-call overrides may reduce those limits. Results include exit code, signal, timeout state, duration, stdout/stderr, byte counts, and truncation flags; non-zero exit codes are returned as command results rather than runtime exceptions. Interrupt and timeout cancellation terminate the spawned shell process tree: POSIX uses the detached process group, and Windows uses `taskkill /T /F` with a `child.kill()` fallback if `taskkill` cannot start.

`diagnose_workspace` runs the workspace typecheck command and returns parsed TypeScript diagnostics. Because it can execute `npm run typecheck` or local `npx --no-install tsc`, it uses the command approval boundary instead of the read-only bypass and receives the same runtime command defaults as `run_command`. When `cwd` points at a subproject, relative TypeScript diagnostic paths are resolved from that command cwd and then reported back as workspace-relative paths. `diagnose_file` validates one workspace file and uses TypeScript Language Service to return syntactic, semantic, and suggestion diagnostics for that file, so it remains read-only and skips approval. This is the current TypeScript diagnostics loop; it does not keep a persistent language server process alive.

Write-mode Markdown file operations remain renderer-invoked IPC services under
`window.agentApi.write.*`. They are not exposed to the model as coding tools;
future Write AI actions should add Write-specific contracts or tools instead
of reusing Code write/command tools.

## Tool Budget

Maximum automatic tool rounds are resolved by `agent_autonomy` and optional environment override:

- `conservative`: 12
- `balanced`: 32
- `deep`: 64
- Runtime clamp range: 1 to 128

If the model keeps requesting tools after the budget:

- Runtime appends failed `ToolItem` records for the unexecuted calls.
- Runtime appends a warning `SystemItem`.
- Runtime persists and emits `tool_budget_reached`; `maxToolRounds` and
  `attemptedToolCalls` are positive integer audit counts.
- Turn status becomes `needs_continuation`.

## Approval Lifecycle

```mermaid
sequenceDiagram
  participant RT as AgentRuntime
  participant Store as JsonlThreadStore
  participant Bus as RuntimeEventBus
  participant UI as Renderer
  participant IPC as approvals-handlers

  RT->>Store: appendItem(ApprovalItem pending)
  RT->>Bus: item_appended
  RT->>Bus: approval_requested
  Bus-->>UI: SSE push
  UI->>IPC: approvals.respond({ approvalId, decision })
  IPC->>RT: respondApproval()
  RT->>Store: appendItem(ApprovalItem with decision)
  RT->>Bus: item_updated
  RT-->>RT: continue or deny tool result
```

Pending approvals are held in memory in `AgentRuntime.pendingApprovals`. They are not resumed across app restart.

Approval items remain in the timeline for auditability. Renderer also shows
the active thread's unresolved approvals in a composer-adjacent pending
approval panel, reusing the same diff preview and allow/deny controls so users
do not have to scroll the timeline to unblock a turn.

Interrupting a turn denies pending approvals for that turn and aborts active tool controllers. Runtime waits briefly for already-started tool execution promises to settle before emitting the interrupted terminal event; if a tool ignores abort beyond that bounded wait, runtime emits a traceable `runtime_error` and continues the interrupt. Command tools receive the abort signal and terminate the child process/process group before the turn is marked interrupted.

## Interrupt Lifecycle

```mermaid
sequenceDiagram
  participant UI as Workbench
  participant IPC as turns-handlers
  participant RT as AgentRuntime
  participant Pool as LlmWorkerPool
  participant Store as JsonlThreadStore
  participant Bus as RuntimeEventBus

  UI->>IPC: turns.interrupt(turnId)
  IPC->>RT: interruptTurn(turnId)
  RT->>RT: set status = interrupted
  RT->>RT: abort active tool controllers
  RT->>Store: append failed ToolItem for running tools
  RT->>RT: bounded wait for active tools to settle
  RT->>RT: deny pending approvals
  RT->>Pool: cancel(threadId)
  RT->>Store: append warning SystemItem
  RT->>Bus: item_appended(SystemItem)
  IPC-->>UI: ok({ turnId })
  Pool-->>RT: worker request settles
  RT->>Store: append truncated partial stream output if present
  RT->>Store: appendEvent(turn_completed status=interrupted)
  RT->>Bus: turn_completed(status=interrupted)
```

Notes:

- Running tools are finalized before the interrupted terminal event so replay and UI state do not leave a tool stuck in `running`.
- If stream content already arrived, runtime persists interrupted assistant output
  with `truncated: true`; if the worker returns normally after cancellation,
  runtime still ignores the final response and keeps the interrupted terminal
  state.
- The interrupted turn remains in the in-flight map until the background run loop
  has persisted partial output/tool cleanup and emitted the terminal event, so a
  new same-thread turn cannot start while the old stream cleanup is still active.

## Turn Completion And Failure

`markTurnStatus()` is the important status boundary inside runtime.

Expected terminal statuses:

- `completed`
- `failed`
- `interrupted`
- `needs_continuation`

Completion persistence:

- Runtime appends `turn_completed` event to `events.jsonl`.
- Runtime emits `turn_completed` on `RuntimeEventBus`.
- Runtime removes the turn from `inFlight`.

Failure behavior:

- Runtime emits `runtime_error` for provider HTTP, provider stream error,
  schema, worker, internal, tool, and persistence categories where available.
- Runtime appends and emits `turn_failed` for top-level run loop failures.
- Runtime marks turn failed through `markTurnStatus("failed")`.

`RuntimeEventBus` carries live UI events such as `item_appended`, `item_updated`, `approval_requested`, and `goal_updated`. The durable event log is narrower: terminal turn usage/failure and tool budget audit events live in `events.jsonl`, while item state lives in `messages.jsonl`.

## Renderer Event Consumption

`Workbench.tsx` keeps SSE subscriptions for every thread opened in the window.
Switching sessions does not unsubscribe the previous thread, so background
turns can still complete, fail, or request approval without leaving renderer
state stale. When a thread is deleted or archived from the sidebar, the
renderer releases any retained subscription for that thread after the main
process confirms the operation.

SSE forwarding remains thread-scoped for normal runtime events. A
`runtime_error` without `threadId` is forwarded once per subscribed window as a
global process-level error, so renderer error handling can surface failures
that are not tied to a specific active thread without duplicating them across
retained thread subscriptions.

Renderer event handling:

- `turn_started`: `actions.turnStarted(event.turn)` keyed by `event.threadId`;
  the current window also advances the matching thread summary activity time
- `item_appended`: append only when the event belongs to the active thread
- `item_updated`: update only when the event belongs to the active thread
- `turn_completed`: `actions.turnEnded(event.threadId, event.status)`
- `turn_failed`: `actions.turnEnded(event.threadId, "failed")`; visible error only for the active thread
- `runtime_error`: visible error only for global errors or the active thread
- `goal_updated`: update active thread goal
- `tool_budget_reached`: no UI error; warning item appears in timeline

State storage:

- `WorkbenchContext.tsx` stores current active-thread `items`, `inFlightTurnsByThreadId`, `activeTurnId`, active thread and composer state.
- `appendItem` and `updateItem` both upsert by item id.

## Runtime Event Types

Defined in `src/shared/agent-contracts.ts`:

- `turn_started`
- `turn_completed`
- `turn_failed`
- `item_appended`
- `item_updated`
- `approval_requested`
- `tool_budget_reached`
- `goal_updated`
- `runtime_error`

`turn_started` includes the complete `TurnRecord` as `event.turn`, so renderer
state uses runtime-created model/profile/mode metadata instead of inferring it
from the current composer state.

When adding an event:

1. Add the type in `src/shared/agent-contracts.ts`.
2. Add its kind to the shared `RUNTIME_EVENT_KINDS` contract so
   `RuntimeEventKind`, `isRuntimeEvent()`, and `RuntimeEventBus.onThread()`
   stay aligned.
3. Forward or consume it in `src/main/ipc/sse-handlers.ts` and renderer logic if needed.
4. Add tests around producer and consumer behavior.

## Change Checklist

Before changing runtime:

- Confirm whether the change affects turn status, item persistence, event emission, or worker protocol.
- Search all existing references with `rg`.
- Keep `src/shared/agent-contracts.ts` as the authority for cross-process shapes.
- Do not add a second runtime entry path.
- Preserve `startTurn()` asynchronous behavior unless explicitly redesigning the UI flow.
- If adding tool behavior, update tool availability and approval rules together.
- If changing events, update shared contracts, event bus, SSE forwarding and renderer reducer/handler.
- If changing persistence, update replay behavior and tests.

Recommended verification for runtime code changes:

```bash
npm run typecheck
npm run test
npm run build
```

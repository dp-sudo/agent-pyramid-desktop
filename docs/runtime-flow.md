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
  participant Att as AttachmentStore
  participant Bus as RuntimeEventBus

  UI->>API: turns.start(TurnStartRequest)
  API->>IPC: ipcRenderer.invoke("turn:start", request)
  IPC->>RT: startTurn(request)
  RT->>Store: getThread(threadId)
  RT->>Config: listProfiles()
  RT->>Att: get(attachmentIds)
  RT->>Store: appendItem(UserItem)
  RT->>Bus: item_appended(UserItem)
  RT->>Bus: turn_started
  RT-->>IPC: TurnRecord(status="in-flight")
  IPC-->>API: ok(TurnRecord)
  API-->>UI: IpcResult<TurnRecord>
  RT-)RT: runTurn(...) in background
```

Important behavior:

- `turns.start()` does not wait for the LLM response to finish.
- The synchronous return is an in-flight `TurnRecord`.
- The visible timeline receives the user item through `item_appended`.
- Later assistant text, reasoning, tools, completion and failure arrive through runtime events.

## Start Preconditions

`AgentRuntime.startTurn()` checks:

- Thread exists via `JsonlThreadStore.getThread()`.
- Thread is not archived.
- Same thread does not already have an in-flight turn.
- Requested `modelProfileId`, when present, exists.
- Attachment ids, when present, resolve through `AttachmentStore.get()`.

Failure mapping:

- Same-thread concurrency throws `RUNTIME_TURN_BUSY`; `turns-handlers.ts` maps it to IPC error code `RUNTIME_TURN_BUSY`.
- Other start failures are returned as `TURN_START_FAILED`.
- Archived thread currently throws `RUNTIME_THREAD_ARCHIVED`; IPC maps it to `TURN_START_FAILED` with that message.

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

Model profile resolution order:

1. Explicit `request.modelProfileId`.
2. `request.model` matching a profile config model.
3. Active profile id.
4. First available profile.

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

## Streaming Semantics

Worker stream chunks are represented by `LlmStreamChunk` in `src/main/domain/agent/types.ts`.

Runtime currently reacts to:

- `text_delta`: lazily creates or updates a live `AssistantItem`, then emits `item_updated`.
- `reasoning_delta`: lazily creates or updates a live `ReasoningItem`, then emits `item_updated`.
- `usage`: updates `turn.usage`.

Final persistence:

- Reasoning and assistant live items are appended to `messages.jsonl` when the stream completes or is interrupted.
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
- Worker replacement clears thread affinity for dead workers.

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
- Other registered tools are enabled by default.

Approval policy currently implemented in runtime:

- Tools marked `metadata.isReadOnly` skip approval.
- Enabled `create_plan` and `update_goal` skip approval.
- `sandboxMode: "read-only"` denies non-read-only tools before execution.
- `approvalPolicy: "never"` denies non-read-only tools before execution.
- `approvalPolicy: "auto"` allows tools whose metadata sets `isDestructive: false`; shell-backed command tools must not use this bypass.
- All remaining non-read-only tools require approval.

`edit_file`, `write_file`, `apply_patch`, and `rollback_file` are destructive workspace tools, so they request approval and can include structured diff previews. `apply_patch` returns a `multi_file_diff` preview when the patch touches more than one file. `rollback_file` uses the current runtime's in-memory file history and refuses to run if the file no longer matches the latest agent-written content. `run_command` is also treated as destructive because arbitrary shell commands can modify files or run workspace scripts; it requests approval even when `approvalPolicy: "auto"` is set.

`apply_patch` applies a restricted unified diff format for UTF-8 create/update hunks. Runtime preview and execution both perform a dry-run first; if any file hunk cannot be applied, no file is written.

File history is currently held in memory by `AgentRuntime`. It covers writes made in the current app process by `edit_file`, `write_file`, `apply_patch`, and `rollback_file`; it is not replayed from JSONL after restart.

`run_command` executes foreground shell commands inside the active workspace only. Its `cwd` is workspace-relative and goes through the shared realpath/path escape policy. Results include exit code, signal, timeout state, duration, stdout/stderr, byte counts, and truncation flags; non-zero exit codes are returned as command results rather than runtime exceptions.

`diagnose_workspace` runs the workspace typecheck command and returns parsed TypeScript diagnostics. Because it can execute `npm run typecheck` or `npx tsc`, it uses the command approval boundary instead of the read-only bypass. `diagnose_file` validates one workspace file and uses TypeScript Language Service to return syntactic, semantic, and suggestion diagnostics for that file, so it remains read-only and skips approval. This is the current TypeScript diagnostics loop; it does not keep a persistent language server process alive.

## Tool Budget

Maximum automatic tool rounds are resolved by `agent_autonomy` and optional environment override:

- `conservative`: 12
- `balanced`: 32
- `deep`: 64
- Runtime clamp range: 1 to 128

If the model keeps requesting tools after the budget:

- Runtime appends failed `ToolItem` records for the unexecuted calls.
- Runtime appends a warning `SystemItem`.
- Runtime persists and emits `tool_budget_reached`.
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

Interrupting a turn denies pending approvals for that turn and aborts active tool controllers. Command tools receive the abort signal and terminate the child process/process group before the turn is marked interrupted.

## Interrupt Lifecycle

```mermaid
sequenceDiagram
  participant UI as Workbench
  participant IPC as turns-handlers
  participant RT as AgentRuntime
  participant Pool as LlmWorkerPool
  participant Store as JsonlThreadStore
  participant Bus as RuntimeEventBus

  UI->>IPC: turns.interrupt(turnId, { force: true })
  IPC->>RT: interruptTurn(turnId)
  RT->>RT: set status = interrupted
  RT->>RT: deny pending approvals
  RT->>RT: abort active tool controllers
  RT->>Pool: cancel(threadId)
  RT->>Store: append warning SystemItem
  RT->>Bus: item_appended(SystemItem)
  RT->>Store: appendEvent(turn_completed status=interrupted)
  RT->>Bus: turn_completed(status=interrupted)
  IPC-->>UI: ok({ turnId })
```

Notes:

- `force` exists in the IPC type but runtime currently cancels via worker pool regardless of option value.
- If stream content already arrived, runtime persists interrupted assistant output with `truncated: true`.

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

- Runtime emits `runtime_error` for worker/internal/tool/persistence categories where available.
- Runtime emits `turn_failed` for top-level run loop failures.
- Runtime marks turn failed through `markTurnStatus("failed")`.

## Renderer Event Consumption

`Workbench.tsx` keeps an active thread subscription through `window.agentApi.sse.subscribe({ threadId })`.

Renderer event handling:

- `item_appended`: `actions.appendItem(event.item)`
- `item_updated`: `actions.updateItem(event.item)`
- `turn_completed`: `actions.turnEnded(event.status)`
- `turn_failed`: `actions.turnEnded("failed")` and visible error
- `runtime_error`: visible error
- `goal_updated`: update active thread goal
- `tool_budget_reached`: no UI error; warning item appears in timeline

State storage:

- `WorkbenchContext.tsx` stores current `items`, `inFlightTurn`, `activeTurnId`, active thread and composer state.
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

When adding an event:

1. Add the type in `src/shared/agent-contracts.ts`.
2. Ensure `RuntimeEventKind` includes it.
3. Update `RuntimeEventBus.onThread()` event list.
4. Forward or consume it in `src/main/ipc/sse-handlers.ts` and renderer logic if needed.
5. Add tests around producer and consumer behavior.

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

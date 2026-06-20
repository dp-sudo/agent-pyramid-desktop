# Runtime Flow

Runtime reference for turn lifecycle, streaming, tools, approval, interrupts, and MCP events. Source authority is code; this document is the shortest operational map.

## Source Files

- `src/main/application/agent-runtime.ts`
- `src/main/application/tool-call-executor.ts`
- `src/main/application/tool-catalog.ts`
- `src/main/application/tool-policy.ts`
- `src/main/application/approval-coordinator.ts`
- `src/main/application/user-input-coordinator.ts`
- `src/main/application/context-compaction.ts`
- `src/main/infrastructure/llm-worker/`
- `src/main/infrastructure/minimax/`
- `src/main/infrastructure/mcp/`
- `src/main/event-bus.ts`
- `src/main/ipc/turns-handlers.ts`
- `src/main/ipc/sse-handlers.ts`
- `src/renderer/src/ui/Workbench.tsx`
- `src/renderer/src/ui/store/WorkbenchContext.tsx`

## Actors

```text
Workbench
  -> window.agentApi.turns / sse / approvals / userInput
  -> turns-handlers.ts / sse-handlers.ts / approvals-handlers.ts
  -> AgentRuntime
  -> JsonlThreadStore + config stores + AttachmentStore + CheckpointStore
  -> ToolCallExecutor + ToolRegistry
  -> LlmWorkerPool
  -> llm-worker
  -> ProviderCompatibleGateway
  -> provider
```

`AgentRuntime` owns the turn state machine. IPC handlers only validate input, call runtime/stores, and return `IpcResult<T>`.

## Start Path

1. Renderer calls `window.agentApi.turns.start(TurnStartRequest)`.
2. `turns-handlers.ts` calls `AgentRuntime.startTurn()`.
3. Runtime normalizes request fields in `turn-start-request.ts`.
4. Runtime rejects missing/archived thread and same-thread in-flight concurrency.
5. Runtime reads model profiles, runtime preferences, thread, and attachments.
6. Runtime resolves model profile through `runtime-turn-decisions.ts` and creates `TurnRecord(status: "in-flight")`.
7. Runtime appends a `UserItem` to `messages.jsonl`.
8. Runtime emits `item_appended` and `turn_started`.
9. IPC returns the in-flight `TurnRecord` immediately.
10. Runtime continues the LLM/tool loop in the background.

Start failure mapping:

- `RUNTIME_TURN_BUSY` -> IPC `RUNTIME_TURN_BUSY`
- `RUNTIME_THREAD_ARCHIVED` -> IPC `RUNTIME_THREAD_ARCHIVED`
- Other start errors -> IPC `TURN_START_FAILED`

## Turn Record

`TurnStatus` in `src/shared/agent-contracts.ts`:

- `in-flight`
- `completed`
- `failed`
- `interrupted`
- `needs_continuation`

`TurnMode`:

- `agent`
- `plan`

Model profile resolution order:

1. Explicit `request.modelProfileId`.
2. Thread-mode default from `RuntimePreferences.codeDefaultModelProfileId` or `writeDefaultModelProfileId`.
3. `request.model` matching a profile config model.
4. Active profile id.
5. First profile.

## Background Loop

Core loop in `AgentRuntime.runTurn()`:

```text
collectHistory()
resolveSkillsForTurn()
build runtime context messages
build user content with text + attachments
for each model/tool round:
  buildLlmRequest()
  prepareMessagesForRequest()
  LlmWorkerPool.chat()
  stream item_updated events
  persist final assistant/reasoning items
  if no tool calls:
    append completion evidence when relevant
    markTurnStatus("completed")
  if tool budget reached:
    append failed ToolItems + warning SystemItem
    emit/persist tool_budget_reached
    markTurnStatus("needs_continuation")
  else:
    executeToolCallsForRound()
    append assistant tool call + tool results to next request messages
```

Context inputs:

- Stable base `SYSTEM_PROMPT`.
- Plan-mode instruction when `TurnRecord.mode === "plan"`.
- Goal instruction when goal mode is active.
- Skill instructions when `RuntimePreferences.skills.enabled`.
- Attachments as `AgentContentBlock[]`; timeline metadata never stores base64.
- Context compaction from selected model profile limits plus `RuntimePreferences.compaction`.

`prepareMessagesForRequest()` repairs provider request history only; it does not rewrite persisted JSONL.

## Streaming

Worker stream chunks become `LlmStreamChunk` values:

- `text_delta`: creates/updates live `AssistantItem`, emits `item_updated`.
- `reasoning_delta`: creates/updates live `ReasoningItem`, emits `item_updated`.
- `usage`: merges usage onto the current `TurnRecord`.

Persistence rules:

- Final assistant/reasoning items are appended to `messages.jsonl`.
- Interrupted/failed partial output is persisted with `truncated: true`.
- JSONL is append-only; repeated item ids are updates.
- `turns.get` and renderer replay dedupe by item id and keep the latest row.

## Worker Flow

`LlmWorkerPool.chat(thread, request, onChunk)`:

- Routes same `threadId` to the same worker while alive.
- Posts chat request to `src/main/infrastructure/llm-worker/worker.ts`.
- Worker calls `ProviderCompatibleGateway.stream()`.
- Worker forwards delta/done/error messages back to pool.
- Pool maps worker/protocol errors into runtime-visible categories.

Cancellation:

- `LlmWorkerPool.cancel(threadId)` sends cancel messages for active requests registered to that thread.
- Worker request uses `AbortController`.
- Initial worker `postMessage()` failures clean listeners and cancel state before surfacing `worker_crashed`.
- Worker exit clears stale thread affinity and creates a replacement.

## Gateway Flow

`ProviderCompatibleGateway` routes by `LlmRequest.protocol`:

- `openai-compatible`: chat completions adapter.
- `anthropic-compatible`: messages adapter.

Provider dialect:

- MiniMax and DeepSeek use provider-specific OpenAI-compatible fields.
- Custom OpenAI-compatible providers use generic chat-completion body shape.
- Anthropic-compatible providers use messages/tool_use/tool_result mapping.

SSE rules:

- Provider `event: error` frames become provider errors.
- Terminal finish/stop frames do not stop reading immediately; tail usage frames are preserved until `[DONE]` or stream close.
- Tool calls are flushed on finish, `[DONE]`, or stream close.

## Tool Loop

All parent-turn tool calls enter `ToolCallExecutor.execute()`:

```text
create running ToolItem
append + emit item_appended
check catalog availability
check registry tool exists
validate schema
check read-only repeat suppression
resolve sandbox/approval/permission policy
request approval when needed
execute registered tool or subagent skill
update ToolItem result/status
emit item_updated
append PlanItem for create_plan/create_edit_plan
return AgentToolResult to next model request
```

Parallelism:

- A model response batch can run in parallel only when every call is registered read-only and none is `run_skill` or `request_user_input`.
- Mixed, write-capable, subagent, and human-input batches run sequentially.
- Result order returned to the next model request matches the model tool-call order.

Repeat suppression:

- Read-only tool calls are keyed by tool name plus canonical arguments per turn.
- From the third identical read-only call, runtime appends a failed visible `ToolItem` and does not execute the tool.
- State clears when the turn reaches a terminal status.

## Tool Availability

Mode-gated tools:

- `create_plan`: plan mode only.
- `create_edit_plan`: read-only Code-mode coordination tool.
- `update_goal`: goal mode or active-goal thread only.

Default read-only tools skip approval unless explicit rules force ask/deny:

- Workspace read tools: `list_files`, `read_file`, `search_files`.
- Developer read tools listed in `RUNTIME_READ_ONLY_TOOL_NAMES`.
- `list_skills`, `run_skill`.
- `request_user_input`.

Write/command-sensitive tools go through approval and sandbox:

- Coding writes: `edit_file`, `multi_edit`, `write_file`, `delete_file`, `apply_patch`, `rollback_file`.
- Foreground commands, shell-specific commands, package wrappers, git commit, command session write/stop.
- `diagnose_workspace`.
- Write-capable MCP tools.

Write threads hide Code-only coding/command tools by default through `ToolCatalogService`. `RuntimePreferences.toolAvailability` can hide known runtime tools per mode, but it does not bypass sandbox or approval checks.

## Command Runtime

Command execution files:

- `command-tools.ts`: tool definitions and session manager integration.
- `command-sandbox.ts`: spawn-time sandbox profile.
- `command-invocation.ts`: shell/package command construction.
- `command-process-runner.ts`: foreground process execution and process-tree cleanup.
- `command-environment.ts`: credential-like env filtering.
- `command-progress-reporter.ts`: live stdout/stderr decoding and `tool_progress`.
- `command-output-capture.ts`: one-shot output truncation.
- `command-session-capture.ts`: bounded session buffers.
- `command-package.ts`: package manager detection/scripts.
- `command-git.ts`: git status/log/pathspec helpers.
- `command-diagnostics.ts`: TypeScript diagnostics and symbols.

Sandbox rule:

- `sandboxMode: "read-only"` hard-denies write/command-sensitive tools.
- `sandboxMode: "workspace-write"` command execution requires a configured Windows helper on Windows and currently fails closed on non-Windows without a supported jail engine.
- `sandboxMode: "danger-full-access"` uses direct host execution after policy and approval checks.

Long-running command sessions are in-memory only and are shut down through the main-process `AppLifecycle` cleanup sequence. The same sequence also closes MCP transports and destroys the LLM worker pool, so Electron's `before-quit` and `window-all-closed` paths share one ordered cleanup module.

## Tool Budget

Constants in `src/main/application/constants.ts`:

- `conservative`: 12 rounds.
- `balanced`: 32 rounds.
- `deep`: 64 rounds.
- `AGENT_MAX_TOOL_ROUNDS`: optional env override, clamped 1..128.
- Warning threshold: 75% of budget.

When budget is exhausted:

- Runtime appends failed `ToolItem` records for unexecuted tool calls.
- Runtime appends warning `SystemItem`.
- Runtime emits and persists `tool_budget_reached`.
- Turn status becomes `needs_continuation`.

## Approval Flow

`ApprovalCoordinator` owns pending approval state in memory.

Flow:

1. Tool policy decides approval is required.
2. Runtime appends pending `ApprovalItem`.
3. Runtime emits `item_appended` and `approval_requested`.
4. Renderer responds through `agentApi.approvals.respond({ approvalId, decision, scope })`.
5. Coordinator updates the approval item and emits `item_updated`.
6. Runtime either executes the tool or returns a denied tool result.

Scopes:

- `once`: current call only.
- `session`: in-memory exact grant scoped to thread/workspace.
- `persist_rule`: writes an exact workspace-scoped `RuntimePreferences.permissionRules` entry.

Stale approval ids return success-shaped `{ accepted: false, reason: "not_pending" }`. Invalid payloads, persistence failures, and runtime exceptions remain real errors.

## User Input Flow

`request_user_input`:

- Appends pending `UserInputItem`.
- Waits for `agentApi.userInput.respond()`.
- Returns answer or cancellation result to the model.
- Stores pending state in memory only.

Stale input ids return `{ accepted: false, reason: "not_pending" }`.

## Interrupt Flow

Renderer calls `turns.interrupt(turnId)`.

Runtime:

1. Finds in-flight turn.
2. Sets status to `interrupted`.
3. Aborts active tool controllers.
4. Resolves pending user inputs.
5. Denies pending approvals.
6. Waits up to `ACTIVE_TOOL_INTERRUPT_SETTLE_TIMEOUT_MS` for active tools.
7. Calls `LlmWorkerPool.cancel(threadId)`.
8. Appends warning `SystemItem`.
9. Background loop persists truncated partial output if any.
10. `markTurnStatus("interrupted")` appends/emits `turn_completed`.

While cleanup is running, the turn remains in `inFlight`, so a same-thread turn cannot start before partial output/tool cleanup is persisted.

## Completion And Failure

Terminal statuses:

- `completed`
- `failed`
- `interrupted`
- `needs_continuation`

`markTurnStatus()`:

- Sets status.
- Sets `completedAt`.
- Appends `turn_completed` to `events.jsonl`.
- Emits `turn_completed`.
- Removes turn from `inFlight`.
- Clears read-only repeat state.

Top-level run failures:

- Emit `runtime_error` when category is known.
- Append/emit `turn_failed`.
- Then mark status `failed`.

Completion evidence:

- Runtime may append an info `SystemItem` before terminal completion for coding/development turns.
- Evidence is derived from durable same-turn `ToolItem.result` values and checkpoint metadata.
- Evidence is audit/UI output, not future model history.

## Runtime Events

Event kinds are owned by `RUNTIME_EVENT_KINDS`:

- `turn_started`
- `turn_completed`
- `turn_failed`
- `item_appended`
- `item_updated`
- `approval_requested`
- `tool_progress`
- `mcp_server_connection`
- `mcp_tool_list_changed`
- `mcp_surface_changed`
- `tool_budget_reached`
- `goal_updated`
- `runtime_error`

Thread-scoped events are forwarded by `bus.onThread(threadId)`.

Process-level events:

- `runtime_error` without `threadId`
- MCP connection/tool/surface events

`sse-handlers.ts` installs one bucket-level process listener per window to avoid duplicating process events for every subscribed thread. Settings uses global SSE subscription for MCP status refresh.

## MCP Runtime Flow

Config authority: `RuntimePreferences.mcpServers`.

Flow:

```text
runtimePreferences.mcpServers
  -> McpHost.configure()
  -> optional cached surface install
  -> connectEnabled() / connect(serverId)
  -> McpClient initialize + list tools/prompts/resources
  -> ToolRegistry.register(mcp__server__tool or facade tools)
  -> MCP runtime events
```

Rules:

- `stdio` transport uses child process JSON-RPC with credential-filtered base env plus configured MCP env.
- `streamable-http` transport posts JSON-RPC to HTTP(S), supports JSON or SSE responses, and reuses `Mcp-Session-Id`.
- Failed server connect unregisters that server's live tools; matching cached tools can remain as lazy placeholders.
- Runtime preference updates await `McpHost.configure()` before reconnecting enabled servers.
- `readOnlyTools` in local runtime preferences is the authority for MCP read-only treatment; remote `readOnlyHint` is informational.
- Prompt/resource list/get/read are renderer IPC surfaces, not model tools.

## Renderer Consumption

Workbench keeps SSE subscriptions for opened threads. Renderer handling:

- `turn_started`: record in-flight turn.
- `item_appended`: append if active thread.
- `item_updated`: update if active thread.
- `tool_progress`: merge live stdout/stderr into matching running tool card.
- `turn_completed`: clear in-flight turn with terminal status.
- `turn_failed`: clear in-flight turn and show active-thread error.
- `runtime_error`: show global or active-thread error.
- `goal_updated`: update active thread goal.
- MCP events: ignored by chat timeline; settings refreshes MCP state.

## Change Checklist

Runtime/tool changes usually require checking:

- `src/shared/agent-contracts.ts`
- `src/main/application/agent-runtime.ts`
- `src/main/application/tool-call-executor.ts`
- `src/main/application/tool-catalog.ts`
- `src/main/application/tool-policy.ts`
- `src/main/application/tools/*`
- `src/main/ipc/*-handlers.ts`
- `src/preload/index.ts` when renderer API changes
- `src/renderer/src/ui/Workbench.tsx`
- `src/renderer/src/ui/store/WorkbenchContext.tsx`
- relevant tests under `tests/main/application/`, `tests/main/ipc/`, `tests/renderer/`
- `docs/runtime-flow.md`, plus `docs/ipc-contracts.md` or `docs/data-model.md` when contracts/storage change

Verification for code changes:

```bash
npm run typecheck
npm run test
npm run build
```

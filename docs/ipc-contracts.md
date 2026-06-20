# IPC Contracts

Renderer-to-main IPC contract map. Channel constants and types in `src/shared/*` are authoritative.

## Authorities

- Channels, descriptors, and allowlist: `src/shared/ipc.ts`
- Request/response contracts: `src/shared/agent-contracts.ts`
- Preload API type: `src/shared/agent-api.ts`
- Error codes: `src/shared/ipc-errors.ts`
- Main handlers: `src/main/ipc/*-handlers.ts`
- Standard handler wrapper: `src/main/ipc/ipc-result-handler.ts`
- Preload implementation: `src/preload/index.ts`
- Renderer global type: `src/renderer/src/global.d.ts`
- Runtime events: `src/main/event-bus.ts`, `RUNTIME_EVENT_KINDS`

Renderer must call through `window.agentApi`; it must not import `src/main/*`.

## Envelope

All renderer-invoked handlers return:

```ts
{ ok: true; value: T } | { ok: false; code: IpcErrorCode; message: string }
```

Use `ok()` and `err()` from `src/shared/agent-contracts.ts`. Handler failures must return a stable code from `IPC_ERROR_CODES` and a concrete message.

## End-To-End Path

```text
Renderer component
  -> window.agentApi.<group>.<method>()
  -> src/preload/index.ts
  -> ipcRenderer.invoke(CHANNEL, payload)
  -> src/main/ipc/*-handlers.ts
  -> runtime/store/service
  -> IpcResult<T>
```

Push events are separate:

```text
RuntimeEventBus
  -> sse-handlers.ts
  -> webContents.send(SSE_PUSH_CHANNEL, event)
  -> preload isRuntimeEvent guard
  -> agentApi.sse.onEvent(listener)
```

## Channel Groups

| Group | Preload namespace | Handler file |
| --- | --- | --- |
| Threads | `agentApi.threads` | `src/main/ipc/threads-handlers.ts` |
| Turns | `agentApi.turns` | `src/main/ipc/turns-handlers.ts` |
| SSE | `agentApi.sse` | `src/main/ipc/sse-handlers.ts` |
| Approvals | `agentApi.approvals` | `src/main/ipc/approvals-handlers.ts` |
| User input | `agentApi.userInput` | `src/main/ipc/user-input-handlers.ts` |
| Goals | `agentApi.goals` | `src/main/ipc/goals-handlers.ts` |
| Attachments | `agentApi.attachments` | `src/main/ipc/attachments-handlers.ts` |
| Usage | `agentApi.usage` | `src/main/ipc/usage-handlers.ts` |
| Checkpoints | `agentApi.checkpoints` | `src/main/ipc/checkpoints-handlers.ts` |
| Workspace | `agentApi.workspace` | `src/main/ipc/workspace-handlers.ts` |
| Write | `agentApi.write` | `src/main/ipc/write-handlers.ts` |
| Model config | `agentApi.modelConfig` | `src/main/ipc/model-config-handlers.ts` |
| Runtime preferences | `agentApi.runtimePreferences` | `src/main/ipc/runtime-preferences-handlers.ts` |
| Skills | `agentApi.skills` | `src/main/ipc/skills-handlers.ts` |
| MCP | `agentApi.mcp` | `src/main/ipc/mcp-handlers.ts` |

## Channels

### Threads

| Channel | Method | Request | Success |
| --- | --- | --- | --- |
| `thread:list` | `threads.list(filter)` | `ThreadListFilter` | `ThreadSummary[]` |
| `thread:create` | `threads.create(input)` | `ThreadCreateInput` | `ThreadRecord` |
| `thread:get` | `threads.get(id)` | `string` | `ThreadRecord` |
| `thread:update` | `threads.update(id, patch)` | `string`, `ThreadUpdatePatch` | `ThreadRecord` |
| `thread:delete` | `threads.delete(id)` | `string` | `{ id: string }` |
| `thread:fork` | `threads.fork(parentId)` | `string` | `ThreadRecord` |

Common errors: `THREAD_*`, `THREAD_NOT_FOUND`, `THREAD_STATUS_INVALID`, `THREAD_ARCHIVE_BUSY`, `THREAD_DELETE_BUSY`.

### Turns

| Channel | Method | Request | Success |
| --- | --- | --- | --- |
| `turn:start` | `turns.start(request)` | `TurnStartRequest` | `TurnRecord` |
| `turn:interrupt` | `turns.interrupt(turnId)` | `string` | `{ turnId: string }` |
| `turn:get` | `turns.get(threadId)` | `string` | `{ threadId: string; items: Item[] }` |

Notes:

- `turn:start` returns before the model finishes.
- Same-thread concurrency maps to `RUNTIME_TURN_BUSY`.
- Archived thread start maps to `RUNTIME_THREAD_ARCHIVED`.
- Output and terminal status arrive through runtime events.
- `turn:get` dedupes append-only JSONL item updates by id.

### SSE

| Channel | Method | Request | Success |
| --- | --- | --- | --- |
| `sse:subscribe` | `sse.subscribe(request)` | `SseSubscribeRequest` | `{ subscribed: string }` |
| `sse:unsubscribe` | `sse.unsubscribe(request)` | `SseUnsubscribeRequest` | `{ unsubscribed: boolean }` |
| `sse:subscribe-global` | `sse.subscribeGlobal()` | none | `{ subscribed: true }` |
| `sse:unsubscribe-global` | `sse.unsubscribeGlobal()` | none | `{ unsubscribed: boolean }` |
| `sse:push` | `sse.onEvent(listener)` | main push only | `RuntimeEvent` |

`sse:push` is not renderer-invoked. Preload drops pushed payloads that fail `isRuntimeEvent()`.

### Approvals And User Input

| Channel | Method | Request | Success |
| --- | --- | --- | --- |
| `approval:respond` | `approvals.respond(request)` | `ApprovalRespondRequest` | `ApprovalRespondResponse` |
| `user-input:respond` | `userInput.respond(request)` | `UserInputRespondRequest` | `UserInputRespondResponse` |

Pending state is in memory. Stale ids return success-shaped responses with `accepted: false` and `reason: "not_pending"`; malformed payloads and persistence/runtime failures return IPC errors.

### Goals

| Channel | Method | Request | Success |
| --- | --- | --- | --- |
| `goal:update` | `goals.update(request)` | `GoalUpdateRequest` | `ThreadRecord` |

Runtime emits `goal_updated` after persistence.

### Attachments

| Channel | Method | Request | Success |
| --- | --- | --- | --- |
| `attachment:create` | `attachments.create(request)` | `AttachmentCreateRequest` | `AttachmentRecord` |
| `attachment:get` | `attachments.get(id)` | `string` | `AttachmentRecord & { dataBase64: string }` |
| `attachment:delete` | `attachments.delete(id)` | preload sends `{ id }` | `AttachmentDeleteResponse` |

Main validates MIME, magic bytes, and size. Timeline items store ids/metadata, not base64.

### Usage

| Channel | Method | Request | Success |
| --- | --- | --- | --- |
| `usage:daily` | `usage.daily(request?)` | `UsageDailyRequest?` | `UsageDailyBucket[]` |

Aggregates persisted `turn_completed.usage`; default window is 30 days, max is 180 days, with short cache.

### Checkpoints

| Channel | Method | Request | Success |
| --- | --- | --- | --- |
| `checkpoint:list` | `checkpoints.list(request)` | `CheckpointListRequest` | `CheckpointListResponse` |
| `checkpoint:rewind` | `checkpoints.rewind(request)` | `CheckpointRewindRequest` | `CheckpointRewindResponse` |

Rewind rejects in-flight threads and re-checks workspace/symlink/hash boundaries before writes.

### Workspace

| Channel | Method | Request | Success |
| --- | --- | --- | --- |
| `workspace:pick-directory` | `workspace.pickDirectory()` | none | `WorkspacePickDirectoryResponse` |

Main owns the Electron directory picker.

### Write

| Channel | Method | Request | Success |
| --- | --- | --- | --- |
| `write:list` | `write.list(request)` | `WriteListRequest` | `WriteFileEntry[]` |
| `write:get` | `write.get(request)` | `WriteGetRequest` | `{ path: string; content: string }` |
| `write:put` | `write.put(request)` | `WritePutRequest` | `{ path: string; bytes: number }` |
| `write:create` | `write.create(request)` | `WriteCreateRequest` | `{ path: string; content: string; bytes: number }` |
| `write:rename` | `write.rename(request)` | `WriteRenameRequest` | `{ path: string; newPath: string }` |
| `write:delete` | `write.delete(request)` | `WriteDeleteRequest` | `{ path: string }` |
| `write:complete` | `write.complete(request)` | `WriteCompleteRequest` | `WriteCompleteResponse` |

Write service resolves workspace from `threadId`, requires write-mode thread, limits paths to Markdown extensions, and reuses workspace path policy. It is renderer IPC, not model tools.

### Model Config

| Channel | Method | Request | Success |
| --- | --- | --- | --- |
| `config:model:get` | `modelConfig.get()` | none | `RendererModelConfig` |
| `config:model:update` | `modelConfig.update(update)` | `ModelConfigUpdate` | `RendererModelConfig` |
| `config:model:profiles:list` | `modelConfig.listProfiles()` | none | `RendererModelConfigProfilesState` |
| `config:model:profiles:create` | `modelConfig.createProfile(request)` | `ModelConfigProfileCreateRequest` | `RendererModelConfigProfilesState` |
| `config:model:profiles:update` | `modelConfig.updateProfile(request)` | `ModelConfigProfileUpdateRequest` | `RendererModelConfigProfile` |
| `config:model:profiles:delete` | `modelConfig.deleteProfile(request)` | `ModelConfigProfileDeleteRequest` | `RendererModelConfigProfilesState` |
| `config:model:profiles:activate` | `modelConfig.activateProfile(request)` | `ModelConfigProfileActivateRequest` | `RendererModelConfigProfilesState` |

Renderer DTOs never expose real `OPENAI_API_KEY`; settings submit a new key only through update payloads.

### Runtime Preferences

| Channel | Method | Request | Success |
| --- | --- | --- | --- |
| `runtime-preferences:get` | `runtimePreferences.get()` | none | `RuntimePreferences` |
| `runtime-preferences:update` | `runtimePreferences.update(update)` | `RuntimePreferencesUpdate` | `RuntimePreferences` |

Preferences share `userData/config` with model profiles. Updating preferences reconfigures `McpHost` through main composition `afterUpdate`.

### Skills

| Channel | Method | Request | Success |
| --- | --- | --- | --- |
| `skills:list` | `skills.list(request)` | `SkillListRequest` | `SkillListResponse` |

Settings diagnostics only. Does not expose full `SKILL.md` bodies or reference contents.

### MCP

| Channel | Method | Request | Success |
| --- | --- | --- | --- |
| `mcp:servers:list` | `mcp.listServers()` | none | `McpServerListResponse` |
| `mcp:servers:connect` | `mcp.connect(request)` | `McpServerConnectRequest` | `McpServerStatusRecord` |
| `mcp:servers:disconnect` | `mcp.disconnect(request)` | `McpServerDisconnectRequest` | `McpServerStatusRecord` |
| `mcp:tools:list` | `mcp.listTools(request?)` | `McpServerToolsRequest?` | `McpServerToolsResponse` |
| `mcp:tools:refresh` | `mcp.refreshTools(request)` | `McpServerRefreshToolsRequest` | `McpServerStatusRecord` |
| `mcp:surface:refresh` | `mcp.refreshSurface(request)` | `McpServerRefreshToolsRequest` | `McpServerStatusRecord` |
| `mcp:prompts:list` | `mcp.listPrompts(request?)` | `McpServerPromptsRequest?` | `McpServerPromptsResponse` |
| `mcp:prompts:get` | `mcp.getPrompt(request)` | `McpPromptGetRequest` | `McpPromptResult` |
| `mcp:resources:list` | `mcp.listResources(request?)` | `McpServerResourcesRequest?` | `McpServerResourcesResponse` |
| `mcp:resources:read` | `mcp.readResource(request)` | `McpResourceReadRequest` | `McpResourceReadResult` |

MCP tools registered into `ToolRegistry` are separate from MCP prompt/resource IPC surfaces. Dynamic tool names use `mcp__<server>__<tool>`.

## Runtime Event Push Contract

Current `RuntimeEvent.kind` values:

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

Forwarding rules:

- Thread events use per-thread subscriptions.
- `runtime_error` without `threadId` is process-level.
- MCP events are process-level and forwarded once per window with a thread or global subscription.
- Settings uses global subscription for MCP status/surface refresh.

Adding a runtime event requires updating shared event union/list/guard, event bus subscriptions, producer, renderer consumer, tests, and this doc.

## Adding IPC

Required steps:

1. Define or update request/response types in `src/shared/agent-contracts.ts` or focused shared submodule.
2. Add channel constant to `src/shared/ipc.ts`.
3. Add a `RENDERER_TO_MAIN_CHANNEL_DESCRIPTORS` entry with its `group` and `method`; `RENDERER_TO_MAIN_CHANNELS` is derived from that descriptor list.
4. Add any new code to `src/shared/ipc-errors.ts`.
5. Implement handler in `src/main/ipc/*-handlers.ts`.
6. Register handler from `src/main/index.ts`.
7. Add method to `src/shared/agent-api.ts`.
8. Expose method in `src/preload/index.ts`.
9. Ensure `src/renderer/src/global.d.ts` still imports the shared API type.
10. Update renderer call sites and tests.
11. Update `docs/ipc-contracts.md`.

Search before and after:

```bash
rg "CHANNEL_NAME|RequestType|ResponseType|methodName" src tests docs
```

## Verification

IPC code changes:

```bash
npm run typecheck
npm run test
npm run build
```

Docs-only changes:

```bash
git diff --check -- docs/ipc-contracts.md
```

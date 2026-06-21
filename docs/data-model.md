# Data Model

Data contract and persistence map. Source code is authoritative; this file lists the shapes and invariants agents must keep synchronized.

## Authorities

| Concern | Authority |
| --- | --- |
| Shared data contracts | `src/shared/agent-contracts.ts` compatibility barrel |
| Thread contracts | `src/shared/thread-contracts.ts` |
| Attachment contracts | `src/shared/attachment-contracts.ts` |
| IPC result envelope | `src/shared/ipc-result.ts` |
| MCP contracts | `src/shared/mcp-contracts.ts` |
| Model config contracts | `src/shared/model-config-contracts.ts` re-exported by `agent-contracts.ts` |
| Primitive guards | `src/shared/contract-primitives.ts` |
| IPC channels | `src/shared/ipc.ts` |
| IPC error codes | `src/shared/ipc-errors.ts` |
| Preload API type | `src/shared/agent-api.ts` |
| Thread store | `src/main/persistence/index.ts` |
| Attachments | `src/main/persistence/attachment-store.ts` |
| Shared config file | `src/main/persistence/config-file.ts` |
| Model config store | `src/main/persistence/model-config-store.ts` |
| Runtime preferences store | `src/main/persistence/runtime-preferences-store.ts`, `runtime-preferences-schema.ts` |
| Checkpoints | `src/main/persistence/checkpoint-store.ts` |
| MCP cache | `src/main/infrastructure/mcp/cache-store.ts` |
| Renderer runtime state | `src/renderer/src/ui/store/WorkbenchContext.tsx` |
| Renderer local preferences | `src/renderer/src/ui/preferences.ts`, `src/renderer/src/i18n/index.ts` |

## Storage Layout

All runtime data is under Electron `userData`, not the repository.

```text
userData/
  threads/
    index.json
    <threadId>/
      thread.json
      messages.jsonl
      events.jsonl
  attachments/
    index.json
    <attachmentId>.bin
  config
  checkpoints/
    <threadId>.jsonl
  mcp/
    cache.json
```

Persistence invariants:

- JSON writes use temp file + fsync + rename.
- JSONL appends use fsync.
- Per-thread thread/checkpoint writes are serialized.
- Replay skips malformed JSONL lines with warning; do not turn this into hard failure without migration.
- UUID and ISO timestamp guards come from shared contract helpers.

## Threads

`ThreadRecord` fields:

- `id`
- `title`
- `workspace`
- `mode`: `code | write`
- `status`: `active | archived`
- `relation`: `primary | fork | side`
- `parentThreadId`
- `forkedAt`
- `createdAt`
- `updatedAt`
- `approvalPolicy`: `auto | on-request | untrusted | never`
- `sandboxMode`: `read-only | workspace-write | danger-full-access`
- `goal`

`ThreadSummary` in `threads/index.json`:

- `id`
- `title`
- `workspace`
- `status`
- `relation`
- `mode`
- `updatedAt`

Rules:

- `workspace` is an absolute path.
- Fork threads require `parentThreadId`.
- Missing legacy `status`, `mode`, `approvalPolicy`, and `sandboxMode` normalize to current defaults.
- `thread:create` uses runtime preference defaults for approval/sandbox when omitted.
- Appending an item advances thread and summary `updatedAt` when the item timestamp is newer.
- Deletion removes the thread directory before removing the index row.

## Goals

`ThreadGoal` lives on `ThreadRecord.goal`.

Fields:

- `text`
- `status`: `active | complete | blocked`
- `createdAt`
- `updatedAt`
- `completedAt`
- `blockedAt`
- `summary`

`goal: null` is a patch boundary value and persists as `goal` absent, not `goal: null`.

## Turns

`TurnRecord` fields:

- `id`
- `threadId`
- `status`: `in-flight | completed | failed | interrupted | needs_continuation`
- `startedAt`
- `completedAt`
- `model`
- `reasoningEffort`
- `modelProfileId`
- `mode`: `agent | plan`
- `goalMode`
- `usage`
- `toolCatalog`

Turn records are not stored as separate files. Lifecycle is reconstructed from:

- runtime in-memory `inFlight`
- `Item.turnId` in `messages.jsonl`
- lifecycle/audit events in `events.jsonl`

`toolCatalog` is diagnostic only: `{ fingerprint, toolCount, toolNames }`.

## Items

Timeline content is append-only JSONL in `messages.jsonl`.

`Item.kind` values:

- `user`
- `assistant`
- `reasoning`
- `tool`
- `compaction`
- `approval`
- `user_input`
- `plan`
- `system`

Update rule:

- Updates append a new row with the same item id.
- Replay consumers dedupe by id and keep the latest row.
- Streaming assistant/reasoning items may be pushed live before final append.
- Do not rewrite old rows for normal item updates.

Important item fields:

- `UserItem`: `text`, optional `displayText`, attachment ids/metadata.
- `AssistantItem`: `text`, optional `truncated`.
- `ToolItem`: `toolCallId`, `name`, `args`, `status`, optional `result`.
- `ApprovalItem`: `approvalId`, `toolName`, `args`, optional preview/decision/scope/resolution.
- `UserInputItem`: `userInputId`, `question`, optional options/answer/cancelled/resolution.
- `PlanItem`: optional `title`, `steps`.
- `SystemItem`: `text`, `level`.

Tool failure results use `ToolFailureResult` with stable `TOOL_FAILURE_CODES`.

## Runtime Events

Runtime events are pushed live through SSE IPC. Persisted lifecycle/audit events live in `events.jsonl`; item state lives in `messages.jsonl`.

`RuntimeEvent.kind` values:

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

Rules:

- Event kind authority is `RUNTIME_EVENT_KINDS`.
- `turn_started.turn` must match repeated top-level turn fields.
- `item_appended.item` and `item_updated.item` must match top-level thread/turn fields.
- `tool_progress` is live-only; final stdout/stderr persistence is through `ToolItem.result`.
- MCP events are process-level and do not carry `threadId`.
- `turn_completed.usage` is the source for `usage:daily`.

## Attachments

Metadata: `AttachmentRecord` in `src/shared/attachment-contracts.ts`, re-exported by `src/shared/agent-contracts.ts`.

Fields:

- `id`
- `name`
- `mimeType`
- `size`
- `createdAt`

Storage:

```text
attachments/
  index.json
  <attachmentId>.bin
```

Rules:

- Supported MIME types: `image/png`, `image/jpeg`, `image/webp`, `image/gif`.
- Max size: `MAX_ATTACHMENT_BYTES` (12 MB).
- Store validates image magic bytes and declared MIME match.
- Names are normalized to basename and bounded by shared contract.
- `UserItem` stores metadata and ids, not base64.
- Runtime rehydrates bytes for LLM `AgentContentBlock[]`.

## Model Config

Contracts:

- `ModelConfig`
- `ModelConfigUpdate`
- `ModelConfigProfile`
- `ModelConfigProfilesState`
- renderer DTOs: `RendererModelConfig*`

Storage: shared `userData/config`.

Rules:

- `ModelConfigStore.get()` returns active profile config.
- `ModelConfigStore.listProfiles()` returns full profile state.
- At least one profile remains.
- Legacy single-config files normalize to profile state.
- Missing legacy `protocol` normalizes to `openai-compatible`.
- Renderer DTOs omit `OPENAI_API_KEY` and expose `hasApiKey` / `apiKeyPreview`.
- Non-empty `OPENAI_API_KEY` is encrypted on disk by `SafeStorageSecretCodec`; runtime memory uses plain `ModelConfig`.
- Deleting a profile clears Code/Write default profile ids that point at it.
- Token limits must satisfy `model_auto_compact_token_limit <= model_context_window` and `max_tokens < model_context_window`.

## Runtime Preferences

Contract: `RuntimePreferences`.

Storage: `runtimePreferences` section in shared `userData/config`.

Main groups:

- `defaultApprovalPolicy`
- `defaultSandboxMode`
- `toolAvailability`
- `codeDefaultModelProfileId`
- `writeDefaultModelProfileId`
- `approvalExperience`
- `command`
- `compaction`
- `skills`
- `permissionRules`
- `mcpServers`

Rules:

- Legacy `userData/runtime-preferences.json` is migration input only when shared config has no runtime preference section.
- Missing/malformed groups normalize to `DEFAULT_RUNTIME_PREFERENCES`.
- Tool availability is catalog-level; it does not bypass sandbox/approval.
- Command limits apply to command-backed tools unless a tool call provides a stricter override.
- Compaction preferences feed `context-compaction.prepareMessagesForRequest()`.
- Skill preferences control discovery, instruction budget, extra roots, and Settings catalog diagnostics.
- `permissionRules` match command/write/MCP subjects; effect priority is `deny > ask > allow`.
- `mcpServers` is the MCP server config authority. Secret-like env/header values are encrypted on disk and redacted to renderer; masked values sent back preserve the current main-process secret.

## Checkpoints

Storage: `userData/checkpoints/<threadId>.jsonl`.

Checkpoint metadata exposed to renderer: `CheckpointMeta`.

Important behavior:

- `beginTurn()` creates/updates a per-turn record.
- `recordFileSnapshot()` keeps earliest before-state and latest after-state per turn/path.
- Failed/rolled-back write snapshots can be discarded.
- `restoreCode()` restores from selected turn forward and re-checks workspace path, symlink boundaries, and live `afterSha256`.
- Mismatched live files are reported as `skippedPaths`.
- `latestFileSnapshot()` supports `rollback_file` fallback only when live file still matches recorded `afterSha256`.
- Checkpoints never bypass workspace policy.

## MCP Cache

Storage: `userData/mcp/cache.json`.

Stores:

- public tool descriptors
- prompt descriptors
- resource descriptors
- capability snapshots
- startup stats

Rules:

- Cache is optimization only; `RuntimePreferences.mcpServers` is authority.
- Cache fingerprint is based on runtime-relevant server config.
- Corrupt/stale cache is ignored.
- Stored records exclude raw env/header secret values.
- Cached tools must still match current server namespace before use.

## Write File Service

Write-mode files live in the active thread workspace, not `userData`.

IPC surface: `window.agentApi.write.*`.

Rules:

- Requests carry `threadId`; main resolves workspace from the write-mode thread.
- Paths are workspace-relative Markdown files: `.md`, `.mdx`, `.markdown`.
- Access reuses workspace policy and realpath/symlink checks.
- Reads use strict UTF-8.
- `create` uses exclusive create.
- `rename` does not overwrite target and rolls back target if source removal fails.
- `complete` is local Markdown pattern completion, not an LLM request and not persisted.

## Renderer State

`WorkbenchContext.tsx` is renderer state only, not runtime persistence authority.

Important state:

- route: `code | write | settings`
- model config/profiles
- runtime preferences projection
- workspace root
- thread list and active thread/items
- in-flight turns by thread id
- composer state
- right panel mode
- error message
- sidebar widths
- basic preferences

Renderer state is built from IPC results, runtime events, and localStorage preferences.

## Local Preferences

localStorage keys:

- `agent-pyramid.basicPreferences` in `src/renderer/src/ui/preferences.ts`
- `agent-pyramid.lastWorkspaceRoot` in `src/renderer/src/ui/preferences.ts`
- `agent-pyramid.locale` in `src/renderer/src/i18n/index.ts`

If a value affects Agent runtime behavior, promote it to `RuntimePreferences`; do not keep it as renderer-only localStorage.

## Field Change Checklist

For cross-process field changes:

1. Update shared contract and focused submodule if any.
2. Update type guards/normalizers.
3. Update stores and migration behavior.
4. Update IPC request/response handlers.
5. Update `src/shared/agent-api.ts` and preload if API shape changes.
6. Update renderer state/call sites.
7. Update tests.
8. Update this doc and any affected domain docs.

Verification for code changes:

```bash
npm run typecheck
npm run test
npm run build
```

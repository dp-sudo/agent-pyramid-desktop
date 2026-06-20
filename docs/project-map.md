# Project Map

Fast map for agents. It describes the current repository, not external reference projects or target-state ideas.

## Summary

`agent-pyramid-desktop` is an Electron + Vite + React + TypeScript desktop Agent Workbench.

```text
renderer React
  -> window.agentApi
  -> preload contextBridge
  -> ipcMain handlers
  -> AgentRuntime / stores / event bus / tool registry
  -> LlmWorkerPool
  -> worker_threads
  -> ProviderCompatibleGateway
  -> provider HTTP API
```

Core invariant: there is one Agent runtime path, `src/main/application/agent-runtime.ts`.

## Repository Boundary

Project sources:

- `src/main/`
- `src/preload/`
- `src/renderer/`
- `src/shared/`
- `tests/`
- `docs/`
- Root configs: `package.json`, `electron.vite.config.ts`, `tsconfig*.json`, `vitest.config.ts`

Not implementation input:

- `node_modules/`, `out/`, `dist/`, `release/`
- `docs/external-references/*` if present
- External repositories such as `F:\cc_src\*`

Do not import, link, build, package, test, or document external reference code as project source.

## Process Map

```text
Renderer: React UI, no Node filesystem access
Preload: src/preload/index.ts exposes window.agentApi
Main: Electron app, IPC handlers, runtime, stores, tools
Worker: src/main/infrastructure/llm-worker/ isolates provider HTTP/SSE
Provider: MiniMax, DeepSeek, custom OpenAI-compatible, Anthropic-compatible
```

Security anchors:

- `src/main/index.ts` keeps `contextIsolation: true` and `nodeIntegration: false`.
- Renderer uses `window.agentApi` and `src/shared/*`, never `src/main/*`.
- Main owns filesystem, workspace boundary checks, external navigation, and persistence.

## Module Map

| Area | Primary files | Responsibility |
| --- | --- | --- |
| Main composition | `src/main/index.ts`, `src/main/application/app-lifecycle.ts` | Wires stores, event bus, worker pool, runtime, tool registry, MCP host, IPC handlers, BrowserWindow, and ordered shutdown cleanup. |
| Main utilities | `src/main/stable-json.ts` | Main-process stable JSON canonicalization used for tool repeat keys, catalog hashing, MCP fingerprints, context estimates, and provider payloads. |
| Runtime | `src/main/application/agent-runtime.ts`, `src/main/application/runtime-turn-decisions.ts` | Turn lifecycle, model profile selection, runtime context message decisions, worker calls, tool loop, interrupt, events. |
| Tool execution | `src/main/application/tool-call-executor.ts` | Tool timeline items, catalog/policy/schema checks, approval/user-input suspension, live progress, interruption cleanup. |
| Tool policy | `src/main/application/tool-catalog.ts`, `src/main/application/tool-policy.ts`, `src/main/application/permission-policy.ts` | Mode filtering, sandbox/approval decisions, runtime permission rules. |
| Built-in tools | `src/main/application/tools/` | Workspace, coding, command, skill, user-input, plan, and goal tools; command input validation lives in `command-input.ts`. |
| Domain ports | `src/main/domain/agent/types.ts`, `src/main/domain/agent/ports.ts` | LLM, tool, message, stream, and registry contracts. |
| LLM worker | `src/main/infrastructure/llm-worker/` | Worker protocol, thread affinity, cancellation, provider stream isolation. |
| Provider gateway | `src/main/infrastructure/minimax/` | `ProviderCompatibleGateway`, OpenAI-compatible adapter, Anthropic-compatible adapter, SSE parsing. |
| MCP | `src/main/infrastructure/mcp/` | MCP client, host, transports, cache, dynamic tool registration, progressive discovery facade, prompts/resources. |
| Persistence | `src/main/persistence/` | JSONL thread store, attachments, config, checkpoints, MCP cache, secret codec. |
| IPC | `src/main/ipc/` | Renderer-callable handlers returning `IpcResult<T>`. |
| Skills | `src/main/skills/`, `src/shared/skills/` | Skill discovery, manifest parsing, built-ins, runtime injection, skill tools. |
| Shared contracts | `src/shared/agent-contracts.ts`, `src/shared/agent-api.ts`, `src/shared/ipc.ts`, `src/shared/ipc-errors.ts` | Cross-process types, preload interface shape, IPC channel descriptors, error codes. |
| Renderer state | `src/renderer/src/ui/store/WorkbenchContext.tsx` | `useReducer` state for route, threads, items, composer, preferences, model/runtime config. |
| Renderer shell | `src/renderer/src/ui/AppShell.tsx`, `src/renderer/src/ui/Workbench.tsx`, `src/renderer/src/ui/SettingsView.tsx` | Route shell, workbench flow, settings flow; live Workbench buffers and Settings runtime save queue live in adjacent helper modules. |
| UI components | `src/renderer/src/ui/components/` | `chat`, `composer`, `sidebar`, `topbar`, `inspector`, `workbench`, `write`, `settings`, `primitives`. |
| UI styles | `src/renderer/src/ui/styles/tokens.css`, `src/renderer/src/ui/styles/shell.css` | Design tokens and shell layout styles. |
| i18n | `src/renderer/src/i18n/`, `src/shared/locale.ts` | Translation resources and supported locale list. |

## Entry Points By Task

| Task | Start here | Also check |
| --- | --- | --- |
| Start/interrupt/get turn | `src/main/ipc/turns-handlers.ts` | `AgentRuntime`, `turn-start-request.ts`, renderer `Workbench.tsx` |
| Runtime event stream | `src/main/event-bus.ts` | `sse-handlers.ts`, preload `sse.onEvent`, renderer runtime-event handling |
| Add/change IPC | `src/shared/ipc.ts` | `agent-contracts.ts`, `agent-api.ts`, handlers, preload, `global.d.ts`, tests, `docs/ipc-contracts.md` |
| Add/change tool | `src/main/domain/agent/types.ts` | relevant file in `tools/`, `src/main/index.ts`, `tool-catalog.ts`, `tool-policy.ts`, tests |
| Change command behavior | `src/main/application/tools/command-tools.ts` | command sandbox/invocation/environment/progress/package/git helpers, approval tests |
| Change LLM protocol | `src/main/infrastructure/minimax/provider-compatible-gateway.ts` | adapters, worker protocol, gateway tests |
| Change MCP | `src/main/infrastructure/mcp/host.ts` | MCP contracts in `agent-contracts.ts`, IPC, settings UI, MCP tests |
| Change skills | `src/main/skills/skill-service.ts` | `src/shared/skills/`, `skill-tools.ts`, settings skills panel, tests |
| Change thread/timeline data | `src/shared/agent-contracts.ts` | `JsonlThreadStore`, runtime replay, renderer timeline, tests, `docs/data-model.md` |
| Change model config | `src/shared/model-config-contracts.ts` | `ModelConfigStore`, IPC handlers, settings model config UI |
| Change runtime preferences | `src/shared/agent-contracts.ts`, `src/shared/runtime-tool-contracts.ts` for tool names | `RuntimePreferencesStore`, runtime, settings runtime preferences UI |
| Change attachments | `src/main/persistence/attachment-store.ts` | contracts, attachment IPC, composer attachment hooks, runtime injection |
| Change checkpoints/rewind | `src/main/persistence/checkpoint-store.ts` | coding tools, checkpoint IPC, inspector/checkpoints UI |
| Change write mode | `src/main/ipc/write-handlers.ts` | write components, write contracts, workspace policy |
| Change UI layout/style | `docs/ui-layout-reference.md` | `docs/ui-design.md`, `tokens.css`, `shell.css`, component tests |
| Add UI text | translation JSON files | `src/shared/locale.ts` only for new locales |

## Data Ownership

| Concept | Authority | Persistence |
| --- | --- | --- |
| Threads, turns, items, runtime events | `src/shared/agent-contracts.ts` | `JsonlThreadStore` under `userData/threads/` |
| Model config profiles | `src/shared/model-config-contracts.ts` | `ModelConfigStore` in shared `userData/config` |
| Runtime preferences | `src/shared/agent-contracts.ts`; tool name authority in `src/shared/runtime-tool-contracts.ts` | `RuntimePreferencesStore` in shared `userData/config` |
| Attachments | `src/shared/agent-contracts.ts` | `AttachmentStore` under `userData/attachments/` |
| Checkpoints | `src/shared/agent-contracts.ts` | `CheckpointStore` under `userData/checkpoints/` |
| MCP cache | MCP contracts in `agent-contracts.ts` | `McpCacheStore` under `userData/mcp/cache.json` |
| IPC channel names | `src/shared/ipc.ts` | Not persisted |
| Preload API shape | `src/shared/agent-api.ts` | Not persisted |
| Locale list | `src/shared/locale.ts` | Not persisted |
| Basic UI preferences | `src/renderer/src/ui/preferences.ts` | `localStorage` |

## Test Map

| Area | Tests |
| --- | --- |
| Shared contracts / IPC allowlist | `tests/shared/` |
| Runtime / tools / policy / commands | `tests/main/application/`, including focused seam tests for runtime decisions, app lifecycle, stable JSON, and command input validation |
| Worker / gateway / MCP infrastructure | `tests/main/infrastructure/`, including provider gateway and MCP facade/cache/host tests |
| IPC handlers | `tests/main/ipc/` |
| Persistence stores | `tests/main/persistence/` |
| Skills | `tests/main/skills/` |
| Preload bridge | `tests/preload/` |
| Renderer reducer/components/helpers | `tests/renderer/`, including focused tests for live event buffering and Settings runtime save queue |

Code-change verification:

```bash
npm run typecheck
npm run test
npm run build
```

Docs-only verification:

```bash
git diff --check -- <changed-docs>
```

## Common Mistakes

- Restoring old single-run runtime paths.
- Letting renderer import `src/main/*`.
- Adding IPC without a `RENDERER_TO_MAIN_CHANNEL_DESCRIPTORS` entry.
- Updating a shared type without guards, handlers, preload, renderer, tests, and docs.
- Treating `tool_progress` as persisted final output instead of live progress.
- Trusting renderer-provided MIME or paths without main-process validation.
- Using external reference folders as implementation input.
- Adding UI text to only one locale.

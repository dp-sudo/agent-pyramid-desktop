# CLAUDE.md

Quick-start for Claude Code and other coding agents. `AGENTS.md` is the rule authority; this file is a shorter operating guide.

## Read First

Before non-trivial edits:

1. `AGENTS.md` sections 1-2 for hard gates and the required Pre-Flight Manifest.
2. `docs/project-map.md` for source boundaries, entry points, and tests.
3. `docs/runtime-flow.md` before runtime, worker, tool, approval, interrupt, MCP event, or stream changes.
4. `docs/ipc-contracts.md` before IPC, preload, or renderer API changes.
5. `docs/data-model.md` before shared contracts, JSONL, attachments, config, checkpoints, MCP cache, or migrations.
6. `docs/ui-design.md` and `docs/ui-layout-reference.md` before UI changes.
7. `openspec/changes/<change-id>/` only when the task explicitly belongs to an existing OpenSpec change.

External reference folders such as `F:\cc_src\*` or `docs/external-references/*` are read-only learning material, not project sources.

## Project Snapshot

`agent-pyramid-desktop` is an Electron + Vite + React + TypeScript desktop Agent Workbench.

Runtime path:

```text
renderer React
  -> window.agentApi
  -> preload contextBridge
  -> ipcMain handlers
  -> AgentRuntime / stores / event bus / tool registry
  -> LlmWorkerPool
  -> worker_threads
  -> MiniMaxGateway
  -> provider HTTP API
```

Do not reintroduce old single-run IPC or orchestration paths. `src/main/application/agent-runtime.ts` is the runtime authority.

## Core Files

- Main composition: `src/main/index.ts`
- Runtime: `src/main/application/agent-runtime.ts`
- Tool execution: `src/main/application/tool-call-executor.ts`
- Tool registry implementations: `src/main/application/tools/`
- Worker pool: `src/main/infrastructure/llm-worker/`
- LLM gateway: `src/main/infrastructure/minimax/minimax-gateway.ts`
- MCP host: `src/main/infrastructure/mcp/host.ts`
- Persistence: `src/main/persistence/`
- IPC handlers: `src/main/ipc/`
- Shared contracts: `src/shared/agent-contracts.ts`
- IPC constants: `src/shared/ipc.ts`
- Preload API type: `src/shared/agent-api.ts`
- Preload bridge: `src/preload/index.ts`
- Renderer state: `src/renderer/src/ui/store/WorkbenchContext.tsx`
- Renderer shell: `src/renderer/src/ui/Workbench.tsx`
- Settings: `src/renderer/src/ui/SettingsView.tsx`

## Invariants

- `turns.start()` returns an in-flight `TurnRecord`; stream updates arrive later as `RuntimeEvent` via `SSE_PUSH_CHANNEL`.
- `messages.jsonl` is append-only; repeated item ids are updates.
- `Item` and `RuntimeEvent` are discriminated unions with guards in `src/shared/agent-contracts.ts`.
- All renderer-invoked IPC returns `IpcResult<T>`.
- Renderer imports only `window.agentApi` and `src/shared/*`, never `src/main/*`.
- Worker threads are routed by `threadId` affinity in `LlmWorkerPool`.
- Tool names are owned by `RUNTIME_TOOL_NAMES`; dynamic MCP tools are `mcp__<server>__<tool>`.
- `RuntimePreferences.permissionRules` can allow/ask/deny command, write, and MCP tool calls after hard sandbox and approval-policy denials.
- `contextIsolation: true` and `nodeIntegration: false` must stay enabled.

## Commands

- `npm install` - install dependencies.
- `npm run dev` - Electron + Vite renderer dev environment.
- `npm run build` - build main, preload, renderer, and the worker entry into `out/`.
- `npm run package:win` - build Windows portable/zip artifacts.
- `npm run package:win:signed` - same, with `forceCodeSigning=true`.
- `npm run typecheck` - TypeScript checks for renderer, main/preload, and tests.
- `npm run test` - Vitest once.
- `npm run test:coverage` - Vitest coverage.
- `npm run preview` - preview production build.
- `npm test -- <path>` - run one test file.
- `npm test -- -t "<name>"` - filter tests by name.

Code-change gate:

```bash
npm run typecheck
npm run test
npm run build
```

Docs-only gate:

```bash
git diff --check -- <changed-docs>
```

Also verify referenced paths exist. No linter or formatter is configured.

## IPC Checklist

Changing renderer-callable IPC usually touches:

- `src/shared/agent-contracts.ts`
- `src/shared/agent-api.ts`
- `src/shared/ipc.ts`
- `src/shared/ipc-errors.ts` when codes change
- `src/main/ipc/*-handlers.ts`
- `src/main/index.ts`
- `src/preload/index.ts`
- `src/renderer/src/global.d.ts`
- renderer call sites
- tests
- `docs/ipc-contracts.md`

## UI Checklist

- Tokens: `src/renderer/src/ui/styles/tokens.css`
- Shell styles: `src/renderer/src/ui/styles/shell.css`
- Components: `chat/`, `composer/`, `sidebar/`, `topbar/`, `inspector/`, `workbench/`, `write/`, `settings/`, `primitives/`
- Local storage keys: `agent-pyramid.basicPreferences`, `agent-pyramid.lastWorkspaceRoot`, `agent-pyramid.locale`
- i18n files: both `zh-CN/translation.json` and `en/translation.json`

## Test Map

- `tests/shared/` - shared contracts and IPC allowlist.
- `tests/main/application/` - runtime, tool policy, commands, compaction, approvals.
- `tests/main/infrastructure/` - worker, gateway, MCP.
- `tests/main/ipc/` - IPC handlers.
- `tests/main/persistence/` - stores.
- `tests/main/skills/` - skill loading/catalog.
- `tests/preload/` - preload bridge.
- `tests/renderer/` - reducer, components, timeline helpers.
- `tests/helpers/temp-dir.ts` - temp directory helper.

## Change Hygiene

- Output the Pre-Flight Manifest before edits.
- Use `rg` / `rg --files` before relying on names.
- Keep changes scoped.
- Do not use `any`, `// @ts-ignore`, silent catches, fake success paths, or real secrets.
- Do not revert unrelated user changes.
- Use `apply_patch` for manual edits.
- Update only docs whose authority is affected.

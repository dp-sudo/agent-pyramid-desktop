# AGENTS.md

Repository rules for coding agents. This file has priority over local style preferences. When it overlaps with `CLAUDE.md` or `docs/*`, this file wins.

## 1. Hard Gates

- Never invent references. Every function, type, field, file, interface, channel, tool name, and config key must be verified by search or file read before use.
- Before editing code, config, contract docs, or project rules, output the Pre-Flight Manifest in section 2.
- Keep scope tight. Modify only files directly needed for the current task.
- Pause for user confirmation when an unresolved choice changes core logic, data shape, protocol, security boundary, or public behavior.
- Do not hide failures. Errors must remain traceable through thrown errors, `IpcResult` errors, visible `ToolItem` failures, logs, or runtime events as appropriate.

## 2. Pre-Flight Manifest

Before any edit, output:

```yaml
[Pre-Flight Manifest]
Task_Goal: "core objective"
Pre_Conditions:
  - "known prerequisite or observed repository fact"
Core_Assumptions:
  - "verified assumption; include how it was verified"
Uncertainties:
  - "write 'none' if there are no blocking uncertainties"
Alternative_Paths:
  - "path A: tradeoff"
Verification_Strategy: "commands or checks that will verify the change"
```

Read-only search and file inspection may happen before the manifest. Editing and state-changing commands happen after it.

## 3. Repository Boundary

Project-owned sources and docs:

- `src/main/`
- `src/preload/`
- `src/renderer/`
- `src/shared/`
- `tests/`
- `docs/`
- Root configs: `package.json`, `package-lock.json`, `electron.vite.config.ts`, `tsconfig*.json`, `vitest.config.ts`

External references such as `F:\cc_src\*` or `docs/external-references/*` are read-only learning material. Do not import, link, copy, build, test, package, or document them as project implementation. Do not add external-reference paths to package, TypeScript, Vite, Electron, Vitest, runtime, or docs dependency config.

## 4. Current Implementation Snapshot

Project: `agent-pyramid-desktop`, an Electron + Vite + React + TypeScript desktop Agent Workbench.

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

Current invariant: `src/main/application/agent-runtime.ts` is the only Agent runtime path. Do not restore old single-run IPC channels, response trace contracts, or alternate orchestrators.

## 5. Source Ownership

- Main composition: `src/main/index.ts`
- Runtime state machine: `src/main/application/agent-runtime.ts`
- Tool execution lifecycle: `src/main/application/tool-call-executor.ts`
- Tool catalog/policy: `src/main/application/tool-catalog.ts`, `src/main/application/tool-policy.ts`
- Built-in tools: `src/main/application/tools/`
- Worker pool and protocol: `src/main/infrastructure/llm-worker/`
- LLM gateway and provider adapters: `src/main/infrastructure/minimax/`
- MCP host/client/cache/transports: `src/main/infrastructure/mcp/`
- Persistence: `src/main/persistence/`
- IPC handlers: `src/main/ipc/`
- Skills service: `src/main/skills/`
- Shared contracts: `src/shared/agent-contracts.ts`, `src/shared/agent-api.ts`, `src/shared/ipc.ts`, `src/shared/ipc-errors.ts`
- Preload bridge: `src/preload/index.ts`
- Renderer state: `src/renderer/src/ui/store/WorkbenchContext.tsx`
- Renderer shell: `src/renderer/src/ui/AppShell.tsx`, `src/renderer/src/ui/Workbench.tsx`, `src/renderer/src/ui/SettingsView.tsx`
- UI tokens/styles: `src/renderer/src/ui/styles/tokens.css`, `src/renderer/src/ui/styles/shell.css`
- i18n: `src/renderer/src/i18n/locales/zh-CN/translation.json`, `src/renderer/src/i18n/locales/en/translation.json`

Renderer code must not import `src/main/*`; it uses `window.agentApi` and `src/shared/*`.

## 6. Change Rules

- Search before editing. Use `rg` / `rg --files` first.
- Prefer existing local patterns and helpers over new abstractions.
- Do not add dependencies unless the existing stack cannot reasonably solve the task.
- Keep one authority per concept: shared types, IPC channel names, runtime tool names, event kinds, locale list, and constants must not be duplicated as ad hoc literals.
- For new or changed fields, interfaces, states, enum-like values, paths, or return values, update all callers, guards, persistence, IPC/preload, renderer consumers, tests, and docs.
- Decide replacement vs coexistence before changing legacy logic. If coexistence is needed, branch near the entry point, not deep in shared logic.
- Do not use `any`, `// @ts-ignore`, silent `catch {}`, fake success returns, or hard-coded real secrets.
- Comments should explain invariants, boundaries, protocol choices, or failure behavior; avoid comments that repeat the code.

## 7. Runtime Rules

- `turns.start()` returns an in-flight `TurnRecord`; text, reasoning, tool updates, and terminal state arrive as `RuntimeEvent` through `SSE_PUSH_CHANNEL`.
- `messages.jsonl` is append-only. Repeated item ids are updates; replay keeps the latest row.
- `RuntimeEvent` and `Item` are discriminated unions in `src/shared/agent-contracts.ts`; update type guards with shape changes.
- Tool names are owned by `RUNTIME_TOOL_NAMES`; read-only names by `RUNTIME_READ_ONLY_TOOL_NAMES`.
- Built-in tools are registered in `src/main/index.ts` through `InMemoryToolRegistry`.
- Write tools, command tools, `diagnose_workspace`, and write-capable MCP tools pass through catalog, sandbox, permission, and approval gates.
- `create_plan` is plan-mode-only. `update_goal` is goal-mode or active-goal-thread-only.
- Write threads hide Code-only coding/command tools by default; tool availability does not bypass sandbox or approval.

## 8. IPC Rules

All renderer-invoked IPC returns `IpcResult<T>`:

```ts
{ ok: true; value: T } | { ok: false; code: IpcErrorCode; message: string }
```

Adding or changing IPC requires synchronized updates to:

- `src/shared/agent-contracts.ts`
- `src/shared/agent-api.ts`
- `src/shared/ipc.ts` and `RENDERER_TO_MAIN_CHANNELS`
- `src/shared/ipc-errors.ts` when error codes change
- `src/main/ipc/*-handlers.ts`
- `src/main/index.ts`
- `src/preload/index.ts`
- `src/renderer/src/global.d.ts`
- renderer call sites and tests
- `docs/ipc-contracts.md`

## 9. Persistence And Security

- Thread data lives under Electron `userData/threads/` with `index.json`, per-thread `thread.json`, `messages.jsonl`, and `events.jsonl`.
- Shared app config lives in `userData/config`; `ModelConfigStore` and `RuntimePreferencesStore` both write through the shared config file.
- Attachments live under `userData/attachments/`; supported MIME types are PNG, JPEG, WebP, GIF; max size is 12 MB; main validates magic bytes.
- Checkpoints live under `userData/checkpoints/` and must re-check workspace boundaries on restore.
- MCP cache lives under `userData/mcp/cache.json`; `RuntimePreferences.mcpServers` remains the authority.
- Keep Electron `contextIsolation: true` and `nodeIntegration: false`.
- Filesystem writes must enforce workspace realpath/path-escape checks.
- Do not expand preload APIs without a typed shared contract and a concrete need.
- Do not commit API keys, certificates, tokens, local secrets, or private paths.

## 10. UI And i18n

- Read `docs/ui-design.md` and `docs/ui-layout-reference.md` before UI changes.
- Use `--ds-*` tokens from `tokens.css`; do not scatter raw hex values.
- Current routes are `code | write | settings` in `WorkbenchContext`.
- Basic preferences use localStorage key `agent-pyramid.basicPreferences`; theme is applied to `<html data-theme>`.
- New user-facing text must update both zh-CN and en translation JSON files.
- New locales must update `src/shared/locale.ts`.
- Renderer errors must become visible state or explicit returned errors.

## 11. Verification

For code changes run:

```bash
npm run typecheck
npm run test
npm run build
```

For docs-only changes:

- Run `git diff --check -- <changed-docs>`.
- Verify referenced paths exist.
- State why build/test were not run.

Common commands:

- `npm install`
- `npm run dev`
- `npm run build`
- `npm run package:win`
- `npm run package:win:signed`
- `npm run typecheck`
- `npm run test`
- `npm run test:coverage`
- `npm run preview`

No linter or formatter is configured. Do not add one without an explicit task.

## 12. Documentation Ownership

- `docs/project-map.md`: source map, entry points, tests, common mistakes.
- `docs/architecture.md`: process/module architecture and ownership.
- `docs/runtime-flow.md`: turn lifecycle, streaming, tools, approval, interrupts, MCP events.
- `docs/ipc-contracts.md`: channels, preload API, handler contract.
- `docs/data-model.md`: shared contracts, persistence, migration rules.
- `docs/ui-design.md`: design tokens, layout grammar, UI rules.
- `docs/ui-layout-reference.md`: page/component layout map.
- `docs/agent-development.md`: maintenance workflow and doc ownership.
- `docs/windows-signing.md`: Windows packaging/signing notes.

Update only the docs affected by the change. Do not use docs as changelogs; current facts belong in docs, history belongs in Git, tests, or an explicit OpenSpec change when one exists.

## 13. Final Self-Check

- [ ] Scope is limited to the requested task.
- [ ] Every new reference was verified in the repository.
- [ ] No unnecessary dependency was added.
- [ ] Failure paths are traceable.
- [ ] No dead code, temporary artifact, stale import, or stale doc remains from this change.
- [ ] Shared contract changes were propagated through main, preload, renderer, tests, and docs.
- [ ] Verification was run or explicitly explained.

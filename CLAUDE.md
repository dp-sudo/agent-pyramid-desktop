# CLAUDE.md

This file is the quick-start guide for Claude Code and other coding agents working in this repository. `AGENTS.md` is the authoritative rulebook. When the two overlap, `AGENTS.md` wins.

## First Read

Read in this order before making a non-trivial change:

1. `AGENTS.md` sections 1-2 for hard gates and the required Pre-Flight Manifest.
2. `docs/project-map.md` for the project map, source ownership, entry points and tests.
3. `docs/runtime-flow.md` before touching `AgentRuntime`, worker streaming, tools, approvals or interrupts.
4. `docs/ipc-contracts.md` before touching IPC, preload or renderer API calls.
5. `docs/data-model.md` before touching shared contracts, JSONL persistence, attachments, model config or migrations.
6. `docs/ui-design.md` and `docs/ui-layout-reference.md` before touching UI layout, styles, tokens or page structure.
7. `openspec/changes/<change-id>/{proposal.md, design.md, tasks.md, specs/}` if the task belongs to an OpenSpec change.

`docs/architecture.md` is the diagram-first architecture reference. `docs/agent-development.md` is the long-running development log and must be updated when Agent framework capabilities change.

If a task belongs to an OpenSpec change, inspect `openspec/changes/<change-id>/proposal.md`, `design.md`, `tasks.md` and `specs/` before editing. Keep `tasks.md` checked off as implementation work lands. The OpenSpec workflow is also exposed as installed skills in `.claude/skills/` (`openspec-propose`, `openspec-explore`, `openspec-apply-change`, `openspec-archive-change`); use them to drive the change end-to-end.

## External Reference Boundary

External directories under `/mnt/f/cc_src/*` and `docs/external-references/*` are read-only learning references only. The `docs/external-references/*` subtree is not project documentation for normal maintenance work.

Never import, link, copy, build, test, package, or document those external reference files as implementation sources. Do not add them to `package.json`, TypeScript config, Vite/Electron config, Vitest config, docs dependency lists, or runtime code. If a pattern is useful, re-implement it inside this repository.

## Project Summary

`agent-pyramid-desktop` is an Electron + Vite + React + TypeScript desktop Agent Workbench.

The real runtime path is:

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

There is one Agent runtime path: `src/main/application/agent-runtime.ts`. Do not reintroduce old single-run IPC or orchestration paths.

## Key Architecture Patterns

The whole codebase rests on a small set of non-obvious invariants. New code that fights any of them is wrong.

- **Fire-and-forget turn + typed event stream.** `turns.start()` returns an in-flight `TurnRecord` within milliseconds. All subsequent text, reasoning, tool updates and terminal state arrive as `RuntimeEvent` values pushed over `SSE_PUSH_CHANNEL`. The renderer never blocks on an LLM call.
- **Append-only timeline, dedupe by id.** `messages.jsonl` is append-only. The same item id appearing multiple times means an update, not a duplicate. `AgentRuntime.collectHistory()` and renderer replays dedupe by id and keep the latest row. Do not rewrite old rows; do not break this dedupe contract.
- **Discriminated unions + type guards, no zod.** Cross-process payloads are tagged unions (`kind` on `Item`, `kind` on `RuntimeEvent`). `isItem` / `isRuntimeEvent` in `src/shared/agent-contracts.ts` are the runtime boundary checks. New payload shapes must update the type and the guard together.
- **Single typed `AgentRuntime` as the only authority.** Main process owns the turn state machine, tool loop, approval gate and persistence. Renderer state is a projection, never a source of truth. There is no second runtime path.
- **Worker isolation by `threadId` affinity.** `LlmWorkerPool` pins a thread to one worker; the worker owns its own `AbortController`; `runtime.interruptTurn()` and the `cancel(threadId)` path collapse into a single AbortSignal reaching the provider fetch.
- **`IpcResult<T>` everywhere, never throw across IPC.** Every renderer-invoked handler returns `{ok:true,value}` or `{ok:false,code,message}`. Runtime events are an additional notification channel, not a replacement.

## Commands

- `npm install` - install dependencies.
- `npm run dev` - start Electron + Vite renderer dev environment. Sets `ELECTRON_RENDERER_URL` for the main process; Vite serves the renderer with HMR and Electron auto-attaches DevTools.
- `npm run build` - build main, preload and renderer into `out/`. The main bundle has **two** rollup entries (`index` and `llm-worker`); the worker entry is loaded at runtime by `LlmWorkerPool`.
- `npm run typecheck` - runs `tsc --noEmit` against three projects in sequence: `tsconfig.json` (renderer), `tsconfig.node.json` (main + preload), `tsconfig.test.json` (tests).
- `npm run test` - run Vitest once and exit.
- `npm run preview` - run the production build of the packaged app.
- `npx vitest` (no `run`) - Vitest watch mode for local iteration.
- `npm test -- <path>` - run a single test file, e.g. `npm test -- tests/main/application/agent-runtime.test.ts`.
- `npm test -- -t "<name>"` - filter by test name substring across all files.

For code changes, the default validation gate is:

```bash
npm run typecheck
npm run test
npm run build
```

For documentation-only changes, run `git diff --check -- <changed-docs>` and verify referenced paths exist. Explain why build/test were not run.

No linter or formatter is configured. Do not add one without an explicit task and plan.

## Process Boundaries

Main process:

- Composition root: `src/main/index.ts`.
- Wires `JsonlThreadStore`, `AttachmentStore`, `ModelConfigStore`, `RuntimePreferencesStore`, `RuntimeEventBus`, `LlmWorkerPool`, `AgentRuntime` and `InMemoryToolRegistry`.
- Registers all `src/main/ipc/*-handlers.ts`.
- Owns Electron security settings, CSP, external navigation and filesystem access.

Worker threads:

- Code lives in `src/main/infrastructure/llm-worker/*`.
- `worker-pool.ts` keeps `threadId -> worker` affinity and supports cancel.
- `worker.ts` instantiates `MiniMaxGateway` and streams typed worker messages back to main.
- Worker protocol is defined in `protocol.ts`.
- The worker has its **own** rollup entry (`llm-worker` in `electron.vite.config.ts`); it is loaded as a separate `node:worker_threads` `Worker` and shares no module state with the main bundle.

Preload:

- `src/preload/index.ts` exposes only `window.agentApi`.
- Keep `contextIsolation: true` and `nodeIntegration: false`.
- Do not widen the preload surface without a typed shared contract and a clear business need.

Renderer:

- React app under `src/renderer/src/`.
- `src/renderer/src/main.tsx` mounts `WorkbenchProvider + AppShell`.
- `AppShell.tsx` routes `code | write` to `Workbench` and `settings` to `SettingsView`.
- `WorkbenchContext.tsx` is the `useReducer` state center. There is no external state library.

## Source Of Truth

Cross-process contracts:

- `src/shared/agent-contracts.ts` defines `ModelConfig`, `RuntimePreferences`, `ThreadRecord`, `TurnRecord`, `Item`, `RuntimeEvent`, approvals, goals, attachments, usage, write-mode requests and `IpcResult<T>`.
- `src/shared/ipc.ts` defines all channel names and `RENDERER_TO_MAIN_CHANNELS`.
- `src/shared/locale.ts` defines supported locales.

If a shared field changes, search first and update all layers:

```bash
rg "fieldName|TypeName|CHANNEL_NAME" src tests docs
```

Then check main handlers, preload, renderer state/call sites and tests.

## Runtime Notes

`turns.start()` returns an in-flight `TurnRecord` quickly. Assistant output, reasoning, tool updates and terminal state arrive later as `RuntimeEvent` values through `SSE_PUSH_CHANNEL`.

Current event kinds:

- `turn_started`
- `turn_completed`
- `turn_failed`
- `item_appended`
- `item_updated`
- `approval_requested`
- `tool_budget_reached`
- `goal_updated`
- `runtime_error`

Tool rounds are controlled by `agent_autonomy` defaults and optional `AGENT_MAX_TOOL_ROUNDS`, clamped from 1 to 128. Current defaults are conservative 12, balanced 32 and deep 64.

Tool rules:

- Tools implement `AgentTool` and are registered through `InMemoryToolRegistry` in `src/main/index.ts`.
- `list_files`, `read_file` and `search_files` are read-only workspace tools and skip approval.
- `edit_file`, `write_file`, `apply_patch` and `rollback_file` are coding write tools; they require approval, workspace path validation and strict UTF-8 text handling. `rollback_file` uses in-memory runtime file history (`file-history-state`) to undo the latest agent write when the current file still matches that history entry.
- `run_command`, `shell_command`, `git_bash_command`, `powershell_command`, `wsl_command`, package/task wrappers, Git commit, and command session write/stop tools all run workspace shell commands and require approval.
- `diagnose_workspace` runs workspace TypeScript/typecheck diagnostics through command execution and requires approval. `diagnose_file` uses TypeScript Language Service for one file and remains read-only.
- Read-only developer tools (`rg_search`, `git_status`, `git_diff`, `git_log`, `git_branch`, `package_scripts`, `read_command_session`, `detect_shell_environment`, `diagnose_file`) skip approval.
- `create_plan` is enabled only in plan mode and skips approval.
- `update_goal` is enabled only in goal mode or active-goal threads and skips approval.
- Write threads hide and reject Code-only coding/command tools by default. Tool access policy may allow or deny tool names per `code` / `write` mode, but approval and sandbox checks still run after catalog filtering.
- Other enabled tool calls go through the approval gate.
- Disallowed or failing tool calls must fail visibly through `ToolItem` state and/or `runtime_error`.

## LLM Gateway

`src/main/infrastructure/minimax/minimax-gateway.ts` implements `LlmGateway` for:

- OpenAI-compatible chat completions.
- Anthropic-compatible messages.
- Provider-specific MiniMax and DeepSeek request body differences.

Model config profiles persist through `ModelConfigStore` in Electron `userData/config`. `AgentRuntime` resolves a profile per turn by explicit `modelProfileId`, Code/Write default profile id from `RuntimePreferences`, model match, active profile, then first profile.

API key resolution:

- Config `OPENAI_API_KEY` wins when present.
- DeepSeek falls back to `DEEPSEEK_API_KEY`, then `OPENAI_API_KEY`.
- MiniMax falls back to `MINIMAX_API_KEY`, then `OPENAI_API_KEY`.
- Other providers fall back to `OPENAI_API_KEY`.

Never hard-code real API keys in code, tests, docs or commits.

## Persistence

Thread store layout under Electron `userData/threads/`:

```text
threads/
  index.json
  <threadId>/
    thread.json
    messages.jsonl
    events.jsonl
```

Key invariants:

- `index.json` stores `ThreadSummary[]`.
- `thread.json` stores `ThreadRecord`.
- `messages.jsonl` stores one `Item` per line.
- `events.jsonl` stores one `RuntimeEvent` per line.
- JSON writes use temp file + fsync + rename.
- JSONL appends use fsync.
- Same-thread writes are serialized.
- Replay skips malformed lines with `console.warn`; do not tighten this without a migration plan.
- Repeated item ids in JSONL represent append-only updates; replay consumers dedupe by id and keep the latest row.

Attachment store:

- Stored under `userData/attachments/`.
- `index.json` stores `AttachmentRecord[]`.
- Binary bytes live in `<attachmentId>.bin`.
- Only PNG, JPEG, WebP and GIF are supported.
- Max attachment size is 12 MB.
- Timeline items store attachment ids and metadata, not base64 bytes.

Model config store:

- Stored in `userData/config`.
- Current shape is `ModelConfigProfilesState`.
- Older single-config data is normalized to profile state.
- At least one profile must remain.

## IPC Rules

All renderer-invoked IPC returns `IpcResult<T>`:

```ts
{ ok: true; value: T } | { ok: false; code: string; message: string }
```

Current preload groups:

- `threads`
- `turns`
- `sse`
- `approvals`
- `goals`
- `attachments`
- `usage`
- `workspace`
- `write`
- `modelConfig`
- `runtimePreferences`

Adding IPC requires updating:

1. `src/shared/agent-contracts.ts`
2. `src/shared/ipc.ts`
3. `RENDERER_TO_MAIN_CHANNELS`
4. `src/main/ipc/*-handlers.ts`
5. `src/main/index.ts`
6. `src/preload/index.ts`
7. renderer call sites
8. tests
9. `docs/ipc-contracts.md`

## Renderer Conventions

- UI tokens live in `src/renderer/src/ui/styles/tokens.css` as `--ds-*`.
- Shell/layout styles live in `src/renderer/src/ui/styles/shell.css`.
- Basic preferences live in `src/renderer/src/ui/preferences.ts` and localStorage key `agent-pyramid.basicPreferences`.
- Last workspace uses localStorage key `agent-pyramid.lastWorkspaceRoot`.
- Locale selection uses localStorage key `agent-pyramid.locale`.
- i18n text must be updated in both `src/renderer/src/i18n/locales/zh-CN/translation.json` and `src/renderer/src/i18n/locales/en/translation.json`.
- Renderer components must not import from `src/main/`; use `window.agentApi` or `src/shared/*`.
- Use current component areas: `chat/`, `composer/`, `sidebar/`, `topbar/`, `inspector/`, `write/`, `settings/`, `primitives/`.

## Security Notes

- Keep Electron `contextIsolation: true` and `nodeIntegration: false`.
- Main process owns filesystem and external navigation.
- Write-mode file access uses `resolveWritePathForAccess()` / `resolveWritePath()` and reuses the shared workspace path policy for lexical checks, realpath checks, symlink escape protection and skipped directory enforcement.
- Workspace tools also enforce workspace boundaries and skip hidden/generated directories.
- Do not expand preload APIs casually.
- Do not place secrets in docs, tests, config or commits.

## Test Map

- `tests/shared/` - shared contracts and IPC allowlist.
- `tests/main/application/` - AgentRuntime and tools.
- `tests/main/infrastructure/` - worker pool and MiniMax gateway/protocol parsing.
- `tests/main/ipc/` - IPC handler behavior.
- `tests/main/persistence/` - thread, attachment and model config stores.
- `tests/renderer/` - renderer reducer, components and timeline helpers.
- `tests/helpers/temp-dir.ts` - temporary directory helper.

Vitest config (`vitest.config.ts`) sets `environment: "node"`, scans `tests/**/*.test.ts` and `.test.tsx`, and excludes `node_modules/` and `out/`. Persistence tests construct a `JsonlThreadStore` against the temp dir helper, never against the real Electron `userData` path.

Run targeted tests while iterating, then the full validation gate for code changes.

## Change Hygiene

Before editing code, output the Pre-Flight Manifest required by `AGENTS.md`.

During edits:

- Use `rg` / `rg --files` first for search.
- Keep changes scoped to the requested task.
- Use existing patterns before inventing abstractions.
- Do not use `any`, `// @ts-ignore`, silent catches, fake success paths or hard-coded secrets.
- Do not revert user changes or unrelated dirty files.
- Use `apply_patch` for manual edits.

After edits:

- Remove dead imports, unused variables and temporary artifacts.
- Update relevant docs from the reading list above.
- Run the required verification for the change type.

## Common Starting Points

- Overall map: `docs/project-map.md`
- Architecture diagrams: `docs/architecture.md`
- Runtime lifecycle: `docs/runtime-flow.md`
- IPC contracts: `docs/ipc-contracts.md`
- Data model: `docs/data-model.md`
- Main composition: `src/main/index.ts`
- Runtime: `src/main/application/agent-runtime.ts`
- Shared contracts: `src/shared/agent-contracts.ts`
- IPC constants: `src/shared/ipc.ts`
- Preload bridge: `src/preload/index.ts`
- Renderer state: `src/renderer/src/ui/store/WorkbenchContext.tsx`
- Workbench UI flow: `src/renderer/src/ui/Workbench.tsx`
- Settings UI: `src/renderer/src/ui/SettingsView.tsx`

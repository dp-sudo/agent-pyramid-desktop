# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⚠️ Read this first — `DeepSeek/` is NOT this project's source code

`DeepSeek/` at the repo root is **third-party reference material only**. It is **not** part of this project's source, **not** a build dependency, and **not** something to be edited, imported, linked, or developed against.

**The real source code of this project lives in:**

- `src/main/` — Electron main process (domain / application / infrastructure / ipc / persistence)
- `src/preload/` — Electron preload bridge
- `src/renderer/` — React renderer (root is `src/renderer/index.html`, code under `src/renderer/src/`)
- `src/shared/` — cross-process types and IPC channel names
- `docs/` — project docs (`docs/agent-development.md`, `docs/ui-design.md`, `docs/minimax/` are read-only protocol references)
- Root config: `package.json`, `electron.vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.test.json`, `vitest.config.ts`

**Hard rules for `DeepSeek/`:**

- Do not `import`, `require`, or reference any file under `DeepSeek/` from `src/`, configs, or docs.
- Do not add it to `package.json`, `tsconfig.json`, Vite/Electron config, or any build/test/lint pipeline.
- Do not edit files under `DeepSeek/` — even drive-by fixes.
- Do not describe `DeepSeek/` as a dependency, source, or implementation basis in `docs/agent-development.md` or any other project doc.
- If a design pattern is needed, **re-implement it in `src/`** — never copy, link, or vendor from `DeepSeek/`.
- This rule applies to humans, to LLM agents (including Claude Code), and to the in-app Agent runtime itself.

`.gitignore` excludes `DeepSeek/`, `.agents/`, `.codex/`, `.claude/`. The full statement is at the top of `AGENTS.md` under "⚠️ 参考资料声明".

## Companion file: `AGENTS.md`

`AGENTS.md` (Chinese) is the **authoritative LLM rulebook** for this repo: hard gates (no hallucinated references, no out-of-scope edits, no swallowed errors), the required **Pre-Flight Manifest** before any code change, IPC change checklist, persistence invariants, and the post-generation self-check. This file (`CLAUDE.md`) is the productivity quick-start — when the two overlap, AGENTS.md wins. Read AGENTS.md sections 1–2 before your first edit in a session, sections 9 / 12 / 17 before changing IPC contracts, persistence, or shipping.

## What this project is

`agent-pyramid-desktop` — an Electron + Vite + React + TypeScript desktop runtime for an agent framework. The architecture is **pyramid layers + multi-turn runtime**: `domain` (types/ports) → `application` (orchestration) → `infrastructure` (LLM/IO) → `preload` (security bridge) → `renderer` (UI).

## Commands

- `npm install` — first time only. On Windows, if Electron download fails, use `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npx install-electron`.
- `npm run dev` — start Electron + Vite renderer dev server (HMR).
- `npm run build` — bundle main, preload, renderer to `out/`.
- `npm run typecheck` — `tsc --noEmit` for renderer, node, **and** test tsconfigs (`tsconfig.json` + `tsconfig.node.json` + `tsconfig.test.json`); test sources are type-checked alongside source.
- `npm run test` — `vitest run` over `tests/**/*.test.ts(x)`. To run a single file: `npx vitest run tests/main/application/agent-runtime.test.ts`. To watch: `npx vitest`. `DeepSeek/`, `node_modules/`, `out/` are excluded by `vitest.config.ts`.
- `npm run preview` — run the production build.

No linter or formatter is configured. After any non-trivial change, treat `npm run typecheck && npm run test && npm run build` as the de facto validation gate.

## Test layout

Tests mirror `src/` shape under `tests/`:

- `tests/shared/` — IPC channel allowlist, contracts type guards.
- `tests/main/persistence/` — `JsonlThreadStore`, `AttachmentStore`, `ModelConfigStore` (single-flight init + serialized writes are the invariants being protected; do not regress).
- `tests/main/infrastructure/` — `minimax-gateway` request bodies and SSE parsing for both protocols.
- `tests/main/application/` — `AgentRuntime` end-to-end (incl. tool-result re-feeding), workspace tool boundaries.
- `tests/main/ipc/` — handler-level tests (e.g. `usage-handlers`).
- `tests/renderer/` — pure reducer test (`WorkbenchContext` exports `INITIAL_STATE` / `Action` / `reducer` *only* for tests; do not consume them in app code) and `timeline-model` grouping logic.
- `tests/helpers/temp-dir.ts` — shared throwaway-directory helper for store tests.

## Three process layers

```
┌──────────────────────┐     contextBridge       ┌─────────────────────┐
│ main process         │ ──── ipcMain.handle ───▶│ renderer (React 19) │
│ src/main/*           │ ◀── webContents.send ───│ src/renderer/src/*  │
│                      │                         │                     │
│ LlmWorkerPool ── spawns worker_threads ── MiniMaxGateway (HTTP)   │
└──────────────────────┘
```

- **Main process** wires `JsonlThreadStore` + `AttachmentStore` + `ModelConfigStore` + `RuntimeEventBus` + `LlmWorkerPool` + `AgentRuntime` + `InMemoryToolRegistry` in `src/main/index.ts` (single composition root, no DI framework). The same file also calls `installContentSecurityPolicy()`, which serves a relaxed CSP in dev (allows Vite's inline preamble + `ws:` for HMR) and a strict CSP (`script-src 'self'`, `connect-src 'self'`) in production — do not loosen the prod policy.
- **Worker threads** (one per pool slot, default `1`) instantiate `MiniMaxGateway` and stream SSE deltas back via a typed `WorkerInbound`/`WorkerOutbound` protocol (`src/main/infrastructure/llm-worker/protocol.ts`). The pool pins `threadId → worker` so per-thread turns execute serially. The worker entrypoint is a separate Vite rollup input (`src/main/infrastructure/llm-worker/worker.ts` → `out/main/llm-worker.js`); when adding worker-side code keep it reachable from that entry.
- **Preload** (`src/preload/index.ts`) exposes a single `window.agentApi` object via `contextBridge.exposeInMainWorld`. It is built as **CommonJS** (`out/preload/index.js`) per `electron.vite.config.ts`; do not switch its output format. Keep `contextIsolation: true` and `nodeIntegration: false`; never widen the surface. Current API groups: `threads`, `turns`, `sse`, `approvals`, `goals`, `attachments`, `usage`, `workspace`, `write`, `modelConfig`. The corresponding main-side handlers are one file per family under `src/main/ipc/`: `threads`, `turns`, `sse`, `approvals`, `attachments`, `goals`, `usage`, `workspace`, `write`, `model-config`.
- **Renderer** is a pure React 19 app with a hand-rolled `useReducer` store (`WorkbenchContext.tsx`); it subscribes to runtime events via `agentApi.sse.subscribe` + `onEvent`. `AppShell.tsx` lazy-loads two route trees by `state.route`: `code | write` → `Workbench`, `settings` → `SettingsView` (the older `SettingsPlaceholder` has been removed).

## Runtime Path

The app has one Agent runtime surface:

**Multi-turn runtime** — `AgentRuntime` (`src/main/application/agent-runtime.ts`) drives `ThreadRecord` + `TurnRecord` + `Item` streams, persistence, the approval gate, and interrupt. This is the path the UI uses (`turn:start`, `turn:interrupt`, `sse:*`).

Within a single turn, when the model returns tool calls, the runtime executes them, appends `assistant`-with-toolCalls + each `tool` result back into `LlmRequest.messages`, and re-asks the model — up to `MAX_TOOL_ROUNDS = 6` rounds (`agent-runtime.ts:77`) before stopping. Tool failures emit `runtime_error` with `code: "tool_failed"`; **errors must not be swallowed to "let the flow continue"** (AGENTS.md §1.5).

The old single-run IPC/API surface has been removed. If you add an agent capability, wire it through `AgentRuntime` and the existing turn/SSE contracts.

## Source of truth contracts (`src/shared/`)

`agent-contracts.ts` is the **only** file that defines cross-process types: `ThreadRecord`, `TurnRecord`, the 9-kind `Item` union (user / assistant / reasoning / tool / compaction / approval / userInput / plan / system), `RuntimeEvent` (8 kinds, including `goal_updated` and `runtime_error`), `ModelConfig`/`ModelConfigUpdate`, attachment / goal / usage / approval / write request shapes, the `IpcResult<T>` envelope, and the `isItem`/`isRuntimeEvent`/`isThreadRecord` type guards that replace zod. `ipc.ts` lists every channel name; `RENDERER_TO_MAIN_CHANNELS` is the renderer-allowlist — any new IPC channel must be added there and registered in `src/main/ipc/`.

If a field moves (rename, type change, new required field), search the codebase for that field name before editing — it is consumed in main, preload, and renderer simultaneously.

## Domain layer rules

`src/main/domain/agent/` must not import from `infrastructure/`, `application/`, `electron`, `react`, or HTTP response shapes. Contracts that cross this boundary: `LlmGateway` (`complete`/`stream`), `ToolRegistry` (`listDefinitions`/`execute`), and the `LlmRequest`/`LlmResponse`/`LlmStreamChunk` shapes. New supplier-specific logic belongs in `infrastructure/`; new orchestration belongs in `application/`.

## LLM gateway

`MiniMaxGateway` (`src/main/infrastructure/minimax/minimax-gateway.ts`) implements both `openai-compatible` and `anthropic-compatible` protocols in one class. It resolves base-URL path suffixes, accumulates tool-call JSON across SSE frames (`OpenAiToolCallAccumulator` / `AnthropicToolCallAccumulator`), and yields typed `LlmStreamChunk`s. Reference: `docs/minimax/` (read-only; never edit; never `import` from inside `src/`).

Settings persist to `userData/config` via `ModelConfigStore`; `AgentRuntime` reads `base_url` / `max_tokens` / `thinking` / `model_reasoning_effort` from there on every turn. The `OPENAI_API_KEY` falls back to `process.env.MINIMAX_API_KEY`. Never hard-code keys.

## Persistence layout (`userData/threads/`)

```
index.json                          # ThreadSummary[], atomic write
<threadId>/thread.json              # ThreadRecord, atomic write
<threadId>/messages.jsonl           # one Item per line, fsync per append
<threadId>/events.jsonl             # one RuntimeEvent per line
```

`JsonlThreadStore` serializes writes per `threadId` (mutex chain), replays via `readline` and **skips malformed lines with a console warning** rather than failing. Replay-tolerant formats are intentional; do not tighten them without a migration plan.

`AttachmentStore` (under `userData/attachments/`) and `ModelConfigStore` (under `userData/config`) are separate stores; both are initialised in `src/main/index.ts` before any IPC handlers are registered. Renderer-facing access goes through `agentApi.attachments.*` (base64 round-trip; do not stream large blobs over IPC) and `agentApi.modelConfig.*`. Attachment index writes are serialized; composer-side delete removes only unsent attachments, not attachments already referenced by persisted user messages.

## Renderer conventions

- Tokens live in `src/renderer/src/ui/styles/tokens.css` as `--ds-*` variables; the design frontmatter in `docs/ui-design.md` mirrors them. Use tokens, not literal hex.
- i18n keys live in `src/renderer/src/i18n/locales/{zh-CN,en}/translation.json`. When adding a new locale, update `src/shared/locale.ts` (`SUPPORTED_LOCALES` + `isSupportedLocale`).
- Components are grouped by area (`chat/`, `composer/`, `sidebar/`, `topbar/`, `inspector/`, `write/`, `primitives/`, `settings/`, `icons/`); the new UI lives in the current `Workbench.tsx` + `AppShell.tsx`.
- Final assistant text is rendered as Markdown via `AssistantMarkdown` (`react-markdown` + `remark-gfm`); intermediate reasoning / tool calls / process-style assistant text are grouped by `turnId` into a collapsible "工作过程" block by `MessageTimeline` — see `tests/renderer/timeline-model.test.ts` for the grouping contract before editing.
- The renderer never imports from `src/main/` directly — only via the `agentApi` bridge or through `src/shared/`.

## Commit / PR conventions

Conventional Commits (`feat:`, `fix:`, `chore:`). When changing the agent framework, LLM gateway, tool mechanism, IPC contract, desktop UI, or i18n, update `docs/agent-development.md` in the same change (add a "变更记录" entry with date, summary, and verification command). For UI changes, attach a screenshot; for protocol changes, cite the relevant `docs/minimax/` file. For substantial design work, use the `openspec-propose` / `openspec-apply-change` / `openspec-archive-change` skills (no tracked `openspec/` directory — changes are archived into `docs/agent-development.md` after implementation).

## When you're stuck

- Thread + turn + item state machines: start at `src/main/application/agent-runtime.ts`, then trace items into `JsonlThreadStore` and back via `replayItems`.
- IPC plumbing: `src/shared/ipc.ts` (channel names) → `src/main/ipc/*-handlers.ts` (main side) → `src/preload/index.ts` (bridge) → `src/renderer/src/ui/Workbench.tsx` (consumer).
- New tool: implement `AgentTool` (`src/main/domain/agent/types.ts`), register via `InMemoryToolRegistry` in `src/main/index.ts`. `ToolRegistry.execute()` is called with an `AgentToolContext` — current fields include `workspace` (current thread workspace path). Existing built-ins to mirror:
  - `echoTool` — smoke test for the tool call chain.
  - `createPlanTool` — returns a plan JSON; exposed and **approval-free only in plan mode**.
  - `createGoalTools(deps)` — factory returning `update_goal`; receives a `GoalToolDeps` callback so the tool can call back into `AgentRuntime.updateThreadGoal` **without importing the runtime**. Use this pattern when a tool needs to mutate thread state. `update_goal` is exposed and approval-free only in goal mode or an active-goal thread.
  - `createWorkspaceTools()` — read-only `list_files` / `read_file` / `search_files`. All paths resolve against `context.workspace` and refuse to escape it. `.git`, `.idea`, `.vscode`, `DeepSeek`, `dist`, `node_modules`, `out` are skipped by default. These are the canonical example of a tool that reads `AgentToolContext`.

  Other tool calls still go through `AgentRuntime.requiresApproval`, and **disallowed tool calls must fail visibly instead of executing** (AGENTS.md §1.5 + §6.3).

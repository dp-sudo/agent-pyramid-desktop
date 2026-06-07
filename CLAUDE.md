# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⚠️ Read this first — `DeepSeek/` is NOT this project's source code

`DeepSeek/` at the repo root is **third-party reference material only**. It is **not** part of this project's source, **not** a build dependency, and **not** something to be edited, imported, linked, or developed against.

**The real source code of this project lives in:**

- `src/main/` — Electron main process (domain / core / application / infrastructure / ipc / persistence)
- `src/preload/` — Electron preload bridge
- `src/renderer/` — React renderer (root is `src/renderer/index.html`, code under `src/renderer/src/`)
- `src/shared/` — cross-process types and IPC channel names
- `docs/` — project docs (`docs/agent-development.md`, `docs/ui-design.md`, `docs/minimax/` are read-only protocol references)
- Root config: `package.json`, `electron.vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `openspec/`

**Hard rules for `DeepSeek/`:**

- Do not `import`, `require`, or reference any file under `DeepSeek/` from `src/`, configs, or docs.
- Do not add it to `package.json`, `tsconfig.json`, Vite/Electron config, or any build/test/lint pipeline.
- Do not edit files under `DeepSeek/` — even drive-by fixes.
- Do not describe `DeepSeek/` as a dependency, source, or implementation basis in `docs/agent-development.md` or any other project doc.
- If a design pattern is needed, **re-implement it in `src/`** — never copy, link, or vendor from `DeepSeek/`.
- This rule applies to humans, to LLM agents (including Claude Code), and to the in-app Agent runtime itself.

`.gitignore` excludes `DeepSeek/`, `.agents/`, `.codex/`, `.claude/`. The full statement is at the top of `AGENTS.md` under "⚠️ 参考资料声明".

## What this project is

`agent-pyramid-desktop` — an Electron + Vite + React + TypeScript desktop runtime for an agent framework. The architecture is **pyramid layers + triangle loop**: `domain` (types/ports) → `core` (mechanisms) → `application` (orchestration) → `infrastructure` (LLM/IO) → `preload` (security bridge) → `renderer` (UI). The agent loop is **observe → reason → act**, tracked in `src/main/core/triangle-loop.ts` (`TriangleTrace`).

## Commands

- `npm install` — first time only. On Windows, if Electron download fails, use `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npx install-electron`.
- `npm run dev` — start Electron + Vite renderer dev server (HMR).
- `npm run build` — bundle main, preload, renderer to `out/`.
- `npm run typecheck` — `tsc --noEmit` for renderer + node tsconfigs.
- `npm run preview` — run the production build.

There is no test runner, no linter, and no formatter configured. After any non-trivial change, treat `npm run typecheck && npm run build` as the de facto validation gate.

## Three process layers

```
┌──────────────────────┐     contextBridge       ┌─────────────────────┐
│ main process         │ ──── ipcMain.handle ───▶│ renderer (React 19) │
│ src/main/*           │ ◀── webContents.send ───│ src/renderer/src/*  │
│                      │                         │                     │
│ LlmWorkerPool ── spawns worker_threads ── MiniMaxGateway (HTTP)   │
└──────────────────────┘
```

- **Main process** wires `JsonlThreadStore` + `ModelConfigStore` + `RuntimeEventBus` + `LlmWorkerPool` + `AgentRuntime` + `InMemoryToolRegistry` in `src/main/index.ts` (single composition root, no DI framework).
- **Worker threads** (one per pool slot, default `1`) instantiate `MiniMaxGateway` and stream SSE deltas back via a typed `WorkerInbound`/`WorkerOutbound` protocol (`src/main/infrastructure/llm-worker/protocol.ts`). The pool pins `threadId → worker` so per-thread turns execute serially.
- **Preload** (`src/preload/index.ts`) exposes a single `window.agentApi` object via `contextBridge.exposeInMainWorld`. Keep `contextIsolation: true` and `nodeIntegration: false`; never widen the surface.
- **Renderer** is a pure React 19 app with a hand-rolled `useReducer` store (`WorkbenchContext.tsx`); it subscribes to runtime events via `agentApi.sse.subscribe` + `onEvent`.

## Two parallel runtimes (intentional, see `docs/agent-development.md`)

Both call into the same `MiniMaxGateway` but serve different IPC surfaces:

1. **Legacy single-run** — `AgentRunner` (`src/main/application/agent-runner.ts`) + `LegacyRunAdapter` (`src/main/application/legacy-run-adapter.ts`) implement the old `agent:run` channel and the `TriangleTrace` (observe/reason/act stages). Kept for backward compatibility with `agentApi.run()`.
2. **Multi-turn runtime** — `AgentRuntime` (`src/main/application/agent-runtime.ts`) drives `ThreadRecord` + `TurnRecord` + `Item` streams, persistence, the approval gate, and interrupt. This is the path the new UI uses (`turn:start`, `turn:interrupt`, `sse:*`).

If you add an agent capability, decide which runtime owns it, and update both call sites if the change crosses the boundary. Don't merge them — the legacy path is the migration safety net.

## Source of truth contracts (`src/shared/`)

`agent-contracts.ts` is the **only** file that defines cross-process types: `ThreadRecord`, `TurnRecord`, the 8-kind `Item` union, `RuntimeEvent` (6 kinds), `ModelConfig`/`ModelConfigUpdate`, `IpcResult<T>` envelope, and the `isItem`/`isRuntimeEvent`/`isThreadRecord` type guards that replace zod. `ipc.ts` lists every channel name; `RENDERER_TO_MAIN_CHANNELS` is the renderer-allowlist — any new IPC channel must be added there and registered in `src/main/ipc/`.

If a field moves (rename, type change, new required field), search the codebase for that field name before editing — it is consumed in main, preload, and renderer simultaneously.

## Domain layer rules

`src/main/domain/agent/` must not import from `infrastructure/`, `application/`, `electron`, `react`, or HTTP response shapes. Contracts that cross this boundary: `LlmGateway` (`complete`/`stream`), `ToolRegistry` (`listDefinitions`/`execute`), and the `LlmRequest`/`LlmResponse`/`LlmStreamChunk` shapes. New supplier-specific logic belongs in `infrastructure/`; new orchestration belongs in `application/`; new mechanisms (like a second loop) belong in `core/`.

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

## Renderer conventions

- Tokens live in `src/renderer/src/ui/styles/tokens.css` as `--ds-*` variables; the design frontmatter in `docs/ui-design.md` mirrors them. Use tokens, not literal hex.
- i18n keys live in `src/renderer/src/i18n/locales/{zh-CN,en}/translation.json`. When adding a new locale, update `src/shared/locale.ts` (`SUPPORTED_LOCALES` + `isSupportedLocale`).
- Components are grouped by area (`chat/`, `composer/`, `sidebar/`, `topbar/`, `inspector/`, `write/`, `primitives/`, `settings/`, `icons/`); the new UI lives in the current `Workbench.tsx` + `AppShell.tsx`.
- The renderer never imports from `src/main/` directly — only via the `agentApi` bridge or through `src/shared/`.

## Commit / PR conventions

Conventional Commits (`feat:`, `fix:`, `chore:`). When changing the agent framework, LLM gateway, tool mechanism, IPC contract, desktop UI, or i18n, update `docs/agent-development.md` in the same change (add a "变更记录" entry with date, summary, and verification command). For UI changes, attach a screenshot; for protocol changes, cite the relevant `docs/minimax/` file. OpenSpec proposals live in `openspec/changes/`.

## When you're stuck

- Thread + turn + item state machines: start at `src/main/application/agent-runtime.ts`, then trace items into `JsonlThreadStore` and back via `replayItems`.
- IPC plumbing: `src/shared/ipc.ts` (channel names) → `src/main/ipc/*-handlers.ts` (main side) → `src/preload/index.ts` (bridge) → `src/renderer/src/ui/Workbench.tsx` (consumer).
- New tool: implement `AgentTool` (`src/main/domain/agent/types.ts`), register via `InMemoryToolRegistry` in `src/main/index.ts`. The approval gate currently asks for permission on **every** tool call (`AgentRuntime.requiresApproval`); map tool name → policy before tightening this.

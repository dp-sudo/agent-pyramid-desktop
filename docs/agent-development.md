# Agent Development

Maintenance entry for agents changing this repository. Use it to decide what to read, what to update, and how to verify.

## Read Order

Always start with:

1. `AGENTS.md`
2. `CLAUDE.md`
3. `docs/project-map.md`

Then read by task:

| Task | Required docs |
| --- | --- |
| Runtime, tool loop, approval, interrupt, MCP runtime events | `docs/runtime-flow.md` |
| IPC/preload/API/event contract | `docs/ipc-contracts.md` |
| Thread/turn/item/event/config/attachment/checkpoint/MCP storage | `docs/data-model.md` |
| UI layout or interaction | `docs/ui-layout-reference.md`, `docs/ui-design.md` |
| System architecture | `docs/architecture.md` |
| Windows packaging/signing | `docs/windows-signing.md` |

Project implementation evidence comes from `src/`, `tests/`, `docs/`, and root config files. External reference folders are not project source.

## Current Runtime Facts

The runtime path diagram, full entry-point list, and source ownership live in `AGENTS.md` (§4-§5) and `docs/project-map.md` (§Summary, §Module Map); see those for authoritative detail. This document covers maintenance process only.

One invariant gates all changes here: there is a single Agent runtime path (`src/main/application/agent-runtime.ts`). Do not restore old single-run orchestration, old trace contracts, or renderer-main shortcuts.

## Documentation Ownership

Update only the docs that match the changed boundary:

| Change | Update |
| --- | --- |
| Module map, entry files, test map | `docs/project-map.md` |
| Process architecture or composition root | `docs/architecture.md` |
| Turn lifecycle, streaming, tools, approval, interrupt, runtime events | `docs/runtime-flow.md` |
| IPC channels, preload API, event push contract, error codes | `docs/ipc-contracts.md` |
| Shared fields, persistence formats, migrations, storage invariants | `docs/data-model.md` |
| UI tokens, visual rules, interaction constraints | `docs/ui-design.md` |
| UI route/component/state layout | `docs/ui-layout-reference.md` |
| Agent maintenance process | `docs/agent-development.md` |
| Packaging/signing commands | `docs/windows-signing.md` |

Do not put changelog entries or temporary task notes in maintenance docs. Use Git history, tests, issues/specs, or task-specific plans for historical tracking.

## Cross-Process Change Checklist

For fields, channels, API methods, runtime events, tool names, or persisted shapes:

1. Search current definitions and call sites with `rg`.
2. Update shared contract authority first.
3. Update guards/normalizers/migrations.
4. Update main handlers/services/stores/runtime.
5. Update preload API and `src/shared/agent-api.ts` if renderer surface changes.
6. Update renderer state and call sites.
7. Update tests.
8. Update the domain docs above.

Common authority files:

- Types: `src/shared/agent-contracts.ts`, focused shared submodules.
- Channels: `src/shared/ipc.ts`.
- Errors: `src/shared/ipc-errors.ts`.
- API shape: `src/shared/agent-api.ts`.
- Runtime events: `RUNTIME_EVENT_KINDS` in shared contracts.
- Tools: `RUNTIME_TOOL_NAMES`, `RUNTIME_READ_ONLY_TOOL_NAMES` in `src/shared/runtime-tool-contracts.ts`, registry wiring in `src/main/index.ts`.

## Runtime And Tool Changes

Check these files before editing runtime behavior:

- `src/main/application/agent-runtime.ts`
- `src/main/application/tool-call-executor.ts`
- `src/main/application/tool-catalog.ts`
- `src/main/application/tool-policy.ts`
- `src/main/application/permission-policy.ts`
- `src/main/application/tools/`
- `src/main/domain/agent/types.ts`
- `src/main/domain/agent/ports.ts`
- relevant tests under `tests/main/application/`

Rules:

- All model-requested tools go through `ToolCallExecutor`.
- Tool visibility starts with `ToolCatalogService`.
- Sandbox/approval/permission decisions go through current policy services.
- Write/command-sensitive tools must not bypass approval and sandbox boundaries.
- Tool failures must produce traceable `ToolItem` results or runtime events.

## IPC Changes

Required path:

```text
src/shared/ipc.ts
src/shared/agent-contracts.ts
src/shared/agent-api.ts
  -> src/main/ipc/*-handlers.ts
  -> src/main/index.ts
  -> src/preload/index.ts
  -> renderer callers
  -> tests
```

Rules:

- Every renderer-invoked handler returns `IpcResult<T>`.
- New renderer-callable channels must be added to `RENDERER_TO_MAIN_CHANNELS`.
- Handler errors need stable codes and concrete messages.
- Push events go through `SSE_PUSH_CHANNEL` and `isRuntimeEvent()`.

## Renderer Changes

Check by area:

| Area | Files |
| --- | --- |
| Route/state | `AppShell.tsx`, `Workbench.tsx`, `WorkbenchContext.tsx` |
| Code timeline | `components/chat/`, `components/workbench/CodeWorkbenchStage.tsx` |
| Composer | `components/composer/`, `workbench-composer-payload.ts` |
| Sidebar/topbar/inspector | `components/sidebar/`, `components/topbar/`, `components/inspector/` |
| Write mode | `components/write/`, `WriteWorkbenchStage.tsx`, write IPC handlers |
| Settings | `SettingsView.tsx`, `settings-*-model.ts`, `components/settings/` |
| Styling | `styles/tokens.css`, `styles/shell.css` |
| i18n | both translation JSON files |

Rules:

- Renderer calls main only through `window.agentApi`.
- UI state uses `WorkbenchContext` and local component state; no new state library.
- New text updates both `zh-CN` and `en`.
- Style changes use `--ds-*` tokens.
- UI errors must be visible or returned to a visible caller.

## Data And Persistence Changes

Check:

- `src/shared/agent-contracts.ts`
- `src/shared/model-config-contracts.ts`
- `src/shared/contract-primitives.ts`
- `src/main/persistence/`
- `src/main/infrastructure/mcp/cache-store.ts`
- `docs/data-model.md`

Rules:

- JSON writes use temp file + fsync + rename.
- JSONL append is append-only and fsynced.
- Replay currently warns and skips malformed JSONL lines.
- Model config and runtime preferences share `userData/config`.
- Renderer DTOs never expose real API keys.
- Checkpoint restore and write IPC must re-check workspace boundaries.

## Dependency Maintenance

The `package.json` `overrides.esbuild` pin is intentional. Vite 7.3.x can otherwise resolve `esbuild` 0.27.x, which is covered by GHSA-g7r4-m6w7-qqqr for Windows development server file reads. Keep the override on a non-vulnerable patch unless `npm audit` and a full build/test pass prove the Vite chain no longer needs it.

When changing dependency versions:

1. Run `npm audit`.
2. Run `npm ls <package>` for any dependency named in the audit output.
3. Run `npm run typecheck`, `npm run test`, and `npm run build`.
4. Update this section if an override is added, removed, or changes reason.

## External Reference Boundary

Not project source:

- `F:\cc_src\*`
- `docs/external-references/*` if present

Do not import, link, copy, build, test, or package external reference code. If a task explicitly asks to study it, treat it as read-only design context and implement inside `src/`.

## Verification

Code changes:

```bash
npm run typecheck
npm run test
npm run build
```

Docs-only changes:

```bash
git diff --check -- <changed-docs>
```

Also verify every newly referenced path exists:

```powershell
Test-Path <path>
```

If build/test commands are skipped for docs-only work, state that in the handoff/final response.

## Documentation Cleanup Rules

Delete content when it is:

- Duplicate of `AGENTS.md`, `CLAUDE.md`, or a domain doc.
- Historical process notes without current maintenance value.
- A claim about a removed path, channel, field, tool, or runtime.
- A future idea without owner, entry point, and verification path.
- Decorative wording that does not help locate or maintain implementation.

Keep content only when it:

- Points to a current implementation entry.
- Defines a current invariant or security boundary.
- Lists required synchronization points.
- Provides executable verification steps.

# UI Design

Agent-readable UI design rules for the current React renderer. Source code is authoritative; this file records stable visual and interaction constraints.

## Authorities

| Concern | Source |
| --- | --- |
| Route shell | `src/renderer/src/ui/AppShell.tsx` |
| Workbench orchestration | `src/renderer/src/ui/Workbench.tsx` |
| Settings orchestration | `src/renderer/src/ui/SettingsView.tsx` |
| Renderer state | `src/renderer/src/ui/store/WorkbenchContext.tsx` |
| Local preferences | `src/renderer/src/ui/preferences.ts` |
| Tokens | `src/renderer/src/ui/styles/tokens.css` |
| Layout/component CSS | `src/renderer/src/ui/styles/shell.css` |
| UI component map | `docs/ui-layout-reference.md` |
| i18n | `src/renderer/src/i18n/`, `src/shared/locale.ts` |

## Product Shape

Routes:

- `code`: chat-style agent workbench for code threads.
- `write`: Markdown workspace with editor, document list, and write assistant.
- `settings`: model, runtime, tools, workbench, and visibility settings.

Runtime boundary:

- Renderer calls `window.agentApi`.
- Renderer imports shared contracts from `src/shared/*`.
- Renderer must not import `src/main/*` or access the filesystem directly.

State:

- Route, threads, items, composer, model/runtime config projections, panel widths, errors, and basic preferences live in `WorkbenchContext`.
- Basic UI preferences persist to `agent-pyramid.basicPreferences`.
- Last workspace persists to `agent-pyramid.lastWorkspaceRoot`.
- Runtime-impacting behavior belongs in `RuntimePreferences`, not renderer-only localStorage.

## Visual System

Token rules:

- Use `--ds-*` tokens from `tokens.css`.
- Do not add scattered raw hex values in component CSS.
- Theme is controlled by `<html data-theme="light" | "dark">`.
- `initTheme()` runs before React render in `src/renderer/src/main.tsx`.
- `prefers-reduced-motion: reduce` zeroes motion tokens.

Token groups:

| Group | Examples |
| --- | --- |
| Background/surface | `--ds-bg-main`, `--ds-bg-sidebar`, `--ds-bg-canvas`, `--ds-surface-*` |
| Text | `--ds-text`, `--ds-text-muted`, `--ds-text-faint`, `--ds-text-placeholder` |
| Border | `--ds-border`, `--ds-border-muted`, `--ds-border-strong` |
| Status | `--ds-success`, `--ds-danger`, `--ds-warning`, `--ds-diff-*`, `--ds-skill` |
| Radius | `--ds-radius-sm` through `--ds-radius-pill` |
| Type | `--ds-font-*`, `--ds-size-*`, `--ds-font-weight-*` |
| Motion | `--ds-motion-micro`, `--ds-motion-standard`, `--ds-motion-deep` |

Layout constants:

- Left sidebar: min `180`, default `268`, max `420`.
- Right inspector: min `280`, default `360`, max `760`.
- Chat content max width: `--ds-chat-content-max-width` (`980px`).
- Code block collapse threshold default: `18`, min `1`, max `200`.

## Layout Grammar

Code route:

```text
ds-workbench-shell
  Sidebar
  ds-workbench-divider
  main.ds-stage-surface
    CodeWorkbenchStage
      WorkbenchTopBar
      MessageTimeline
      PendingApprovalPanel
      FloatingComposer
      WorkbenchErrorToast
      RightInspector optional
```

Write route:

```text
ds-workbench-shell
  main.ds-stage-surface
    WriteWorkbenchStage
      WriteWorkspaceView
        write sidebar
        WriteEditorPanel
        WriteAssistantPanel
      WorkbenchErrorToast
```

Settings route:

```text
ds-workbench-shell
  SettingsView
    SettingsSidebar
    settings main form
    section tabs
    SettingsCard groups
```

## Interaction Rules

General:

- Use visible error state for renderer failures; do not silently swallow failed IPC.
- Use inline confirmation for destructive thread, profile, and document actions.
- Resizers must support pointer drag, keyboard arrows, and double-click reset where implemented.
- Long text, paths, tool details, and Markdown output must stay bounded or scrollable.
- Do not add a landing page; `code`, `write`, and `settings` open real work surfaces.

Composer:

- `FloatingComposer` has `code` and `write` variants.
- Code variant supports text, image upload/paste, attachment thumbnails, model profile selection, reasoning effort, plan mode, and goal mode.
- Write variant reuses the shell but hides plan/goal controls; write assistant sends explicit prompts, not implicit full-document mirroring.
- Attachment upload/paste entry points obey `WorkbenchBasicPreferences`.

Timeline:

- `MessageTimeline` groups `Item[]` by turn after stable `createdAt` sorting.
- Code histories are windowed at turn boundaries before expensive rendering.
- Live output follows the bottom only while the user remains near the bottom.
- `tool_progress` is live progress only; final tool output is `ToolItem.result`.
- Failed tools and approvals stay visible.

Markdown:

- `AssistantMarkdown` uses `react-markdown` and `remark-gfm`.
- Unsafe links render as text; only `http(s)` external links are clickable.
- Images are limited to safe `http(s)` or supported image `data:` URLs.
- Code fences render through `ds-code-block`; empty fences do not create blank shells.
- Long code blocks collapse by `basicPreferences.codeBlockCollapseLineThreshold`.

Approval and user input:

- Pending approvals render in the timeline and near the composer.
- Approval buttons enter a submitting state until backend resolution or failure.
- `request_user_input` renders choices/free-form answer and cancellation state.

## Settings Structure

Sections and categories come from `settings-navigation-model.ts`:

| Section | Categories |
| --- | --- |
| `basic` | `appearance` |
| `model` | `profiles`, `connection`, `context`, `reasoning` |
| `agent` | `compaction`, `skills` |
| `tools` | `permissions`, `mcpServers`, `toolAccess`, `commandLimits` |
| `workbench` | `startup`, `layout`, `session`, `modelDefaults`, `attachments` |
| `visibility` | `approvalPresentation` |

Persistence:

- `basic` and UI-only workbench preferences use localStorage via `preferences.ts`.
- Model sections use `window.agentApi.modelConfig.*`.
- Runtime/tool/agent/visibility settings use `window.agentApi.runtimePreferences.*`.
- Skills catalog diagnostics use `window.agentApi.skills.list()`.
- MCP status and surface data use `window.agentApi.mcp.*` plus global SSE events.

## Write Mode

Write mode facts:

- Entry: `WriteWorkbenchStage` -> `WriteWorkspaceView`.
- File service: `window.agentApi.write.*`.
- Thread mode: `ThreadRecord.mode === "write"`.
- Markdown file extensions accepted by main write IPC: `.md`, `.mdx`, `.markdown`.
- Editor state is local to `WriteWorkspaceView`; it does not overwrite global composer text.
- Write assistant turns use write threads and explicit composer payloads.

Rules:

- Save dirty Markdown before route/session/document switches when the existing flow requires it.
- Main process remains the authority for workspace path policy.
- Destructive document actions require inline confirmation or an explicit context-menu command.
- Invalid path, UTF-8, save, completion, or IPC failures must surface in UI state.

## i18n

- Supported locales are `zh-CN` and `en`.
- Locale authority is `src/shared/locale.ts`.
- Translation files:
  - `src/renderer/src/i18n/locales/zh-CN/translation.json`
  - `src/renderer/src/i18n/locales/en/translation.json`
- New visible UI text must update both locale files.

## Do Not Add

- A second runtime status system in the renderer.
- Runtime switchers or diagnostics panels that bypass existing settings/runtime events.
- Tailwind, Zustand, React Router, or another UI framework without explicit approval.
- Renderer filesystem access.
- ASCII `x` dismiss icons where `CloseGlyph` is already used.
- Emoji as production UI affordances.
- Raw API keys, certificate paths, or secrets in UI text, docs, fixtures, or tests.

## Change Checklist

UI changes usually require checking:

- `src/renderer/src/ui/store/WorkbenchContext.tsx`
- `src/renderer/src/ui/Workbench.tsx`
- `src/renderer/src/ui/SettingsView.tsx`
- affected component directory under `src/renderer/src/ui/components/`
- `src/renderer/src/ui/preferences.ts` for local preference changes
- `src/shared/agent-contracts.ts` and preload API if runtime data changes
- both translation JSON files for new text
- `tokens.css` / `shell.css` for style changes
- `docs/ui-design.md` and `docs/ui-layout-reference.md`

Verification for code changes:

```bash
npm run typecheck
npm run test
npm run build
```

Docs-only verification:

```bash
git diff --check -- docs/ui-design.md
```

# UI Layout Reference

Current renderer layout map. This document names the route owners, major components, state ownership, and interaction boundaries agents need before editing UI.

## Entry Points

| Area | File | Notes |
| --- | --- | --- |
| React root | `src/renderer/src/main.tsx` | Calls `initTheme()`, mounts `WorkbenchProvider` + `AppShell`, imports `tokens.css` and `shell.css`. |
| Route shell | `src/renderer/src/ui/AppShell.tsx` | Lazy-loads `Workbench` for `code`/`write`, `SettingsView` for `settings`. |
| Workbench orchestration | `src/renderer/src/ui/Workbench.tsx` | Threads, SSE, send/interrupt, approvals, user input, route split. |
| Settings orchestration | `src/renderer/src/ui/SettingsView.tsx` | Model profiles, runtime preferences, MCP, skills, local preferences. |
| State | `src/renderer/src/ui/store/WorkbenchContext.tsx` | `useReducer`; no external state library. |
| Preferences | `src/renderer/src/ui/preferences.ts` | localStorage-backed basic preferences and width constants. |

## Routes

`WorkbenchRoute` values:

- `code`
- `write`
- `settings`

Route rendering:

```text
AppShell
  if route code/write -> Workbench
  if route settings -> SettingsView
```

`Workbench` renders:

- Code route: `Sidebar`, divider, `CodeWorkbenchStage`.
- Write route: `WriteWorkbenchStage` only; write sidebar lives inside `WriteWorkspaceView`.

## State Ownership

Important `WorkbenchState` fields:

| Field | Owner/use |
| --- | --- |
| `route` | Selects `code`, `write`, or `settings`. |
| `workspaceRoot` | Shared active workspace path for code/write. |
| `threads` | Thread summaries for route sidebars. |
| `activeThread`, `activeThreadId` | Selected thread and detail state. |
| `items` | Active-thread timeline items. |
| `inFlightTurnsByThreadId` | Running turns by thread; supports background sessions. |
| `modelConfig`, `modelProfiles` | Renderer projection of model config state. |
| `runtimePreferences` | Renderer projection of runtime preferences. |
| `composer` | Draft, model selection, reasoning effort, mode, goal mode, attachments. |
| `rightPanelMode` | `changes`, `checkpoints`, `todo`, `plan`, or closed. |
| `leftSidebarWidth`, `rightSidebarWidth` | Resizable panel widths. |
| `basicPreferences` | Theme, startup, layout, session, attachment, Markdown display defaults. |
| `errorMessage` | Workbench error toast source. |

LocalStorage:

- `agent-pyramid.basicPreferences`
- `agent-pyramid.lastWorkspaceRoot`
- `agent-pyramid.locale`

## Code Route Layout

Components:

```text
Workbench
  Sidebar
  ds-workbench-divider
  main.ds-stage-surface
    CodeWorkbenchStage
      WorkbenchTopBar
      MessageTimeline
      PendingApprovalPanel
      FloatingComposer variant="code"
      WorkbenchErrorToast
      RightInspector
```

Primary responsibilities:

| Component | Responsibility |
| --- | --- |
| `Sidebar` | Workspace picker, code thread list, archive/delete/restore, route switch, settings button. |
| `WorkbenchTopBar` | Active thread status, workspace path, approval/sandbox selectors, inspector mode controls. |
| `MessageTimeline` | Group/sort/window timeline items and render turn blocks. |
| `ChatBlock` | Render item kinds: user, assistant, reasoning, tool, approval, user input, plan, system, compaction. |
| `PendingApprovalPanel` | Composer-adjacent unresolved approvals for the active thread. |
| `FloatingComposer` | Prompt input, attachments, model/reasoning picker, plan/goal toggles, send/interrupt. |
| `RightInspector` | Changes, checkpoints, todo, and plan panels for active code thread. |
| `WorkbenchErrorToast` | Visible runtime/UI error with dismiss and copy support. |

Width behavior:

- Left sidebar uses `LEFT_SIDEBAR_MIN_WIDTH`, `LEFT_SIDEBAR_DEFAULT_WIDTH`, `LEFT_SIDEBAR_MAX_WIDTH`.
- Right inspector uses `RIGHT_INSPECTOR_MIN_WIDTH`, `RIGHT_INSPECTOR_DEFAULT_WIDTH`, `RIGHT_INSPECTOR_MAX_WIDTH`.
- Resizers use `role="separator"`, keyboard arrow handling, pointer drag, and reset helpers.

## Timeline Layout

Timeline model:

- Raw `Item[]` is sorted by `createdAt` with stable tie-breaking.
- Grouping is done by `groupTimelineTurns()`.
- Long code histories are truncated at whole-turn boundaries before heavy rendering.
- Post-answer follow-up items remain after the final assistant output.

Render rules:

| Item kind | Rendering |
| --- | --- |
| `user` | User bubble plus attachment names. |
| `assistant` | `AssistantMarkdown`; live output can use shiny styling; final non-empty output has copy action. |
| `reasoning` | Collapsible process entry; live opens by default; completed default from preferences unless user toggled. |
| `tool` | Code route uses compact rows; write/settings use process cards; long details are bounded. |
| `approval` | Approval block with args, optional diff preview, scoped allow/deny actions. |
| `user_input` | Question, choices/free-form answer, cancel, and resolved state. |
| `plan` | Ordered steps with status classes. |
| `system` / `compaction` | System-style timeline blocks. |

Live behavior:

- Text/reasoning deltas are coalesced by `workbench-live-event-buffer.ts`.
- `tool_progress` merges live stdout/stderr into running tool display.
- Scroll follows live output only when the user is near the bottom.
- Failed tools remain visible even if read-only successful tools are hidden by preferences.

## Markdown Renderer

Component: `AssistantMarkdown`.

Dependencies:

- `react-markdown`
- `remark-gfm`

Rules:

- Streaming markdown temporarily closes dangling triple-backtick fences.
- Links are normalized; unsafe/local protocols are rendered as text.
- Images must be safe `http(s)` or supported image `data:` URLs.
- Code blocks use `ds-code-block`.
- Long code blocks collapse using `basicPreferences.codeBlockCollapseLineThreshold`.
- Tables are wrapped for horizontal overflow.
- Task-list checkboxes are disabled.

## Composer

Component: `FloatingComposer`.

Variants:

| Variant | Controls |
| --- | --- |
| `code` | Text, image upload/paste, attachment tray, model picker, reasoning effort, plan toggle, goal toggle, send/interrupt. |
| `write` | Text, attachment support where enabled, model picker, send/interrupt; plan/goal controls hidden. |

Attachment state:

- Authoritative attachment ids: `state.composer.attachmentIds`.
- Display records: `state.composer.attachments`.
- Upload/paste availability comes from `basicPreferences.allowComposerImageUpload` and `allowComposerImagePaste`.
- Main process validates bytes and MIME; renderer thumbnails are not authority.

## Write Route Layout

Components:

```text
WriteWorkbenchStage
  WriteWorkspaceView
    write workspace sidebar
    WriteEditorPanel
    WriteAssistantPanel
  WorkbenchErrorToast
```

`WriteWorkspaceView` owns:

- Workspace selection.
- Write thread selection/creation/archive/delete/restore.
- Markdown file list/search/create/rename/delete.
- Active document load/save state.
- Dirty document guard.
- Inline completion request state.
- Prompt context sent to write assistant.

Write IPC:

- `window.agentApi.write.list`
- `window.agentApi.write.get`
- `window.agentApi.write.put`
- `window.agentApi.write.create`
- `window.agentApi.write.rename`
- `window.agentApi.write.delete`
- `window.agentApi.write.complete`

Write assistant:

- Component: `WriteAssistantPanel`.
- Uses `FloatingComposer variant="write"`.
- Displays grouped write-thread timeline, pending approvals, reasoning, tools, plans, system messages, and final assistant output.
- Sends explicit prompt payloads through `onSendAssistantPrompt`.
- Does not implicitly mirror the full Markdown document into global composer state.

Editor:

- Component: `WriteEditorPanel`.
- Source and preview behavior is renderer-owned.
- Save button is enabled only when there is an active file, workspace, no active load/save, and content differs from saved content.
- File operation errors must surface in the write view state.

## Settings Route Layout

Components:

```text
SettingsView
  SettingsSidebar
  settings main form
    section tabs
    SettingsCard
    SettingRow
    Toggle / SecretInput / StatusBadge
    SettingsSkillsPanel
    SettingsMcpServersPanel
```

Sections:

| Section | Categories | Persistence |
| --- | --- | --- |
| `basic` | `appearance` | localStorage/i18n/theme helpers |
| `model` | `profiles`, `connection`, `context`, `reasoning` | `agentApi.modelConfig.*` |
| `agent` | `compaction`, `skills` | `agentApi.runtimePreferences.*`; skills diagnostics via `agentApi.skills.list()` |
| `tools` | `permissions`, `mcpServers`, `toolAccess`, `commandLimits` | `agentApi.runtimePreferences.*`; MCP status via `agentApi.mcp.*` |
| `workbench` | `startup`, `layout`, `session`, `modelDefaults`, `attachments` | localStorage plus runtime preferences for model defaults |
| `visibility` | `approvalPresentation` | runtime preferences |

Navigation:

- Section tabs come from `getSettingsSectionItems()`.
- Category sidebar items come from `getSettingsNavItems()`.
- Search is scoped to the active section.
- Advanced filter hides categories marked by `isSettingsCategoryAdvanced()`.
- Dirty model profile state blocks unsafe section/category/profile navigation.

Runtime preferences:

- Settings serializes runtime preference saves and merges pending updates while a save is in flight.
- Runtime controls are disabled during load/save or when preload is unavailable.
- MCP settings subscribe to global SSE for server/surface changes.

## i18n And Copy

Rules:

- All user-visible text uses i18n keys.
- Update both translation files for new text.
- Add new locales only through `src/shared/locale.ts` plus locale resources.
- Avoid production emoji and decorative text-only symbols where an existing primitive exists.

## CSS Class Anchors

Core classes:

- `ds-workbench-shell`
- `ds-stage-surface`
- `ds-sidebar`
- `ds-workbench-divider`
- `ds-chat-stage`
- `ds-chat-column`
- `ds-message-timeline`
- `ds-message-block`
- `ds-composer-shell`
- `ds-right-inspector`
- `ds-write-workspace`
- `ds-settings-root`
- `ds-settings-sidebar`
- `ds-settings-card`

Before renaming a class, search `src/renderer/src/ui`, `tests/renderer`, and docs.

## Change Checklist

Update this document when changing:

- Route names or ownership.
- `WorkbenchState`, `ComposerState`, `RightPanelMode`, or basic preference fields.
- Page-level component hierarchy.
- Settings sections/categories.
- Sidebar/inspector width constants.
- Timeline grouping/rendering rules.
- Composer variant behavior.
- Write workspace workflow.
- Renderer-visible IPC workflows.

Docs-only verification:

```bash
git diff --check -- docs/ui-layout-reference.md
Test-Path src/renderer/src/ui/AppShell.tsx
Test-Path src/renderer/src/ui/Workbench.tsx
Test-Path src/renderer/src/ui/SettingsView.tsx
```

# UI Layout And Attributes Reference

This document describes the current pages, layout regions, state ownership,
interaction behavior, and visual attributes for the desktop workbench UI.

Primary implementation files:

- `src/renderer/src/ui/AppShell.tsx`
- `src/renderer/src/ui/Workbench.tsx`
- `src/renderer/src/ui/SettingsView.tsx`
- `src/renderer/src/ui/store/WorkbenchContext.tsx`
- `src/renderer/src/ui/components/**`
- `src/renderer/src/ui/preferences.ts`
- `src/renderer/src/ui/styles/tokens.css`
- `src/renderer/src/ui/styles/shell.css`

## Global UI Shell

```mermaid
flowchart LR
  Provider["WorkbenchProvider"]
  AppShell["AppShell"]
  Code["Workbench: code route"]
  Write["Workbench: write route"]
  Settings["SettingsView"]

  Provider --> AppShell
  AppShell -->|"route = code"| Code
  AppShell -->|"route = write"| Write
  AppShell -->|"route = settings"| Settings
```

Global root:

- Class: `ds-workbench-shell`.
- Route source: `WorkbenchContext.state.route`.
- Routes: `code`, `write`, `settings`.
- Lazy loaded route components: `Workbench`, `SettingsView`.
- Empty loading fallback: `ds-route-fallback`, a full-size surface using
  `var(--ds-bg-main)`.

Global visual system:

- Design tokens live in `tokens.css` and use `--ds-*`.
- Structural and component styles live in `shell.css`.
- Theme is controlled by `<html data-theme>` and `agent.theme` local storage
  logic in `src/renderer/src/i18n/index.ts`.
- Basic UI preferences live under `agent-pyramid.basicPreferences`.
- Last workspace lives under `agent-pyramid.lastWorkspaceRoot`.

## Shared State And Preferences

State owner: `WorkbenchContext`.

Important UI state:

| State | Purpose |
| --- | --- |
| `route` | Selects code, write, or settings page. |
| `workspaceRoot` | Current workspace path for code/write flows. |
| `threads` | Sidebar thread summaries. |
| `activeThread`, `activeThreadId` | Selected code thread. |
| `items` | Timeline items for selected thread. |
| `inFlightTurnsByThreadId` | Tracks running turns per thread, enabling background sessions without blocking the active composer. |
| `rightPanelMode` | Inspector panel mode or closed state; cleared when the active timeline is deselected. |
| `composer` | Draft text, model, reasoning effort, mode, goal mode, attachments. |
| `errorMessage` | Visible workbench error toast. |
| `leftSidebarWidth`, `rightSidebarWidth` | Resizable panel dimensions. |
| `basicPreferences` | Theme/startup/session/sidebar/inspector and message display defaults. |

Dimension constants from `preferences.ts`:

| Constant | Value | Usage |
| --- | ---: | --- |
| `LEFT_SIDEBAR_MIN_WIDTH` | 180 | Code/write left panel clamp. |
| `LEFT_SIDEBAR_DEFAULT_WIDTH` | 268 | Default left panel width. |
| `LEFT_SIDEBAR_MAX_WIDTH` | 420 | Code/write left panel clamp. |
| `RIGHT_INSPECTOR_MIN_WIDTH` | 280 | Inspector clamp. |
| `RIGHT_INSPECTOR_DEFAULT_WIDTH` | 360 | Default inspector width. |
| `RIGHT_INSPECTOR_MAX_WIDTH` | 760 | Inspector clamp. |

## Code Page

Implementation entry: `Workbench` when `state.route === "code"`.

### Layout

```mermaid
flowchart LR
  Sidebar["Left Sidebar\nThread/workspace navigation"]
  Divider["Resizable divider"]
  Stage["CodeWorkbenchStage\nChat Stage"]
  Topbar["Topbar"]
  Timeline["MessageTimeline"]
  Composer["FloatingComposer + error toast"]
  Inspector["RightInspector optional"]

  Sidebar --> Divider
  Divider --> Stage
  Stage --> Topbar
  Stage --> Timeline
  Stage --> Composer
  Stage --> Inspector
```

Top-level regions:

- Left sidebar container:
  - Class: `ds-sidebar`.
  - Width: `state.leftSidebarWidth`.
  - Clamp: `180..420`.
  - Resizable by pointer drag and keyboard separator.
- Divider:
  - Class: `ds-workbench-divider`.
  - Role: `separator`.
  - Keyboard: arrows adjust by `SIDEBAR_KEYBOARD_STEP = 16`.
  - Double click resets width to `LEFT_SIDEBAR_DEFAULT_WIDTH`.
- Main stage:
  - Class: `ds-stage-surface`.
  - Code route child component: `CodeWorkbenchStage`.
  - Code route child class: `ds-chat-stage`.
- Topbar frame:
  - Class: `ds-chat-topbar-frame`.
  - Padding: `--ds-space-3`.
- Stage body:
  - Class: `ds-chat-stage-body`.
  - Owns the horizontal chat column + optional inspector row.
- Chat column:
  - Classes: `ds-chat-column ds-chat-column-inset`.
- Composer dock:
  - Classes: `ds-chat-composer-dock` and `ds-chat-composer-frame`.
  - Composer frame max width shares `min(100%, --ds-chat-content-max-width)`
    with the timeline content column so model output and input stay aligned.
- Right inspector:
  - Class: `ds-right-inspector`.
  - Width: `state.rightSidebarWidth`.
  - Visible only when `rightPanelMode !== null`.
  - Rendered by `CodeWorkbenchStage`; `Workbench` keeps SSE, IPC, send,
    interrupt, approval and route orchestration.

### Sidebar

Component: `Sidebar`.

Purpose:

- Create new chat.
- Pick/change workspace.
- Display active workspace.
- Toggle archived thread visibility.
- Group Code threads by `workspace`; Write threads are managed inside the
  Write workspace route and are not shown in the Code sidebar.
- Select, archive, restore, and delete threads.
- Open Settings route.
- Switch quickly between Code and Write workbenches.

Key classes:

- `ds-sidebar-header`
- `ds-sidebar-workspace`
- `ds-sidebar-archive-toggle`
- `ds-sidebar-list`
- `ds-sidebar-project-group`
- `ds-sidebar-project-title`
- `ds-sidebar-row`
- `ds-sidebar-row-main`
- `ds-sidebar-row-actions`
- `ds-sidebar-delete-confirm`
- `ds-sidebar-footer`
- `ds-sidebar-workbench-switch`
- `ds-sidebar-workbench-button`

Thread row attributes:

- Active row: `is-active`.
- Archived row: `is-archived`.
- Pending delete confirmation: `is-confirming-delete`.
- Thread operation submitting: `is-busy` with `aria-busy`.
- Main button uses `aria-current="page"` when active.
- Delete always uses inline confirmation before calling the thread delete API.
- Pending delete confirmation is pruned when the backing thread disappears from
  the current list, such as after archive/delete/filter refreshes.
- Archive, restore and delete confirmation actions enter a local submitting
  state and disable sidebar row action buttons until the async parent callback
  settles. If a callback rejects, the Sidebar routes the error into the shared
  workbench error state.
- Footer workbench switch uses the existing `WorkbenchContext.actions.setRoute`
  path for `code` / `write`; switching to a workbench route clears an active
  thread whose persisted `mode` does not match that route. Settings remains a
  separate button.
- The Code sidebar divider uses `ds-workbench-divider`; pointer resizing adds
  `is-dragging` so the handle stays highlighted while the pointer is down, not
  only during hover/focus.

### Topbar

Component: `WorkbenchTopBar`.

Purpose:

- Show active/no session status.
- Show short thread id.
- Show workspace path.
- Show running indicator.
- Open inspector modes: changes, todo, plan.
- Toggle inspector open/closed.

Key classes:

- `ds-topbar-surface`
- `ds-topbar-session`
- `ds-topbar-title`
- `ds-topbar-meta`
- `ds-topbar-workspace`
- `ds-topbar-actions`
- `ds-topbar-running`
- `ds-segmented-control`
- `ds-topbar-inspector-tabs`

Inspector controls:

- Modes: `changes`, `todo`, `plan`.
- Toggle label comes from `getInspectorToggleLabel()`.
- Mode buttons and the open/close toggle use `aria-controls` to target the
  shared `RightInspector` region; the open/close toggle also reflects
  `aria-expanded`.

### Timeline

Component: `MessageTimeline`.

Purpose:

- Group raw `Item[]` into turns via `groupTimelineTurns()`.
- Sort timeline items by `createdAt` with stable tie-breaking before grouping,
  so renderer event arrival order cannot reshuffle user text, reasoning, tool
  records or final assistant output.
- Before grouping long Code histories, keep only the most recent visible turn
  window at the raw `Item[]` boundary. Older turns stay available through the
  localized `ds-message-show-older` control, and the window boundary must never
  split items that share one `turnId`.
- Render user, pre-answer work process, assistant, and follow-up items without
  moving post-answer items ahead of the answer.
- Keep scroll pinned to bottom while user is near the bottom.
- Show `InitialSessionUsageHeatmap` when no items exist.
- Empty-session usage cells are exposed as one labeled `role="img"` heatmap;
  individual cells stay visual/tooltip-only and are hidden from assistive tech.

Key classes:

- `ds-message-timeline`
- `ds-message-timeline-empty`
- `ds-message-timeline-content`
- `ds-message-show-older`
- `ds-message-jump-bottom`
- `ds-message-turn`
- `ds-message-turn-process`
- `ds-work-process`
- `ds-work-process-summary`
- `ds-work-process-body`
- `ds-shiny-text`

Scroll behavior:

- Timeline content max width uses `min(100%, --ds-chat-content-max-width)`,
  the same outer width as the Code composer frame.
- Sticky threshold: `96px`.
- When the user scrolls away from latest output, `MessageTimeline` shows a
  localized `ds-message-jump-bottom` button. Activating it restores the scroll
  position to the latest item and re-enables bottom stickiness.
- Active turn work process opens by default.
- User toggles are stored by turn id and pruned when turns disappear. Controlled
  `details` updates that only mirror the active-turn default are ignored, so a
  programmatic live/completed state change does not become a user override.
- Closed work-process sections render only their summary. Process item blocks
  are mounted after the section opens, avoiding markdown/tool/diff work for
  folded historical turns.
- Work-process grouping is route-scoped: the Write route renders the grouped
  `ds-work-process` disclosure above; the Code route drops that wrapper and
  renders process rows in a `ds-message-turn-process` column directly after the
  user message. Running, failed, approval, write, and reasoning items stay
  directly visible; consecutive completed read-only tool records fold into a
  compact read-only summary row that can be expanded for individual details.

### Chat Blocks

Component: `ChatBlock`.

Item rendering:

| Item kind | UI |
| --- | --- |
| `user` | Right-side user bubble with optional attachment names. |
| `assistant` | Markdown assistant bubble. Live output gets shiny styling. |
| `reasoning` | Collapsible process entry with reasoning label and markdown body. Live reasoning opens by default; completed reasoning follows `basicPreferences.openReasoningByDefault` until the user explicitly toggles it. Closed completed reasoning shows a light text preview and does not mount the markdown body. |
| `tool` | Code route: compact `ds-process-tool-row` (action label + title preview) that expands to the same detail frame as the card; consecutive completed read-only rows may be grouped under a read-only summary. Failed command titles use a short preview while full args/results remain in detail. Completed coding tools with `ToolItem.result.diff` show a changed-file compact title and render `ds-tool-diff-preview` with only the changed diff lines instead of raw result JSON. Write/settings route: full `ds-process-entry ds-process-tool` card with status/tone summary. Long non-diff details render as a bounded preview with an explicit full-detail toggle in both routes. Running command-backed tools may show temporary `[stdout]` / `[stderr]` progress details; the final tool result replaces that temporary progress when `item_updated` arrives. |
| `approval` | Approval block with args JSON and allow/deny buttons. |
| `user_input` | System-style user input prompt. |
| `plan` | Plan block with ordered steps and per-step status class. |
| `compaction` | System-style compaction notice. |
| `system` | System bubble. |

Key classes:

- `ds-message-block`
- `ds-user-bubble`
- `ds-assistant-bubble`
- `ds-message-attachments`
- `ds-process-entry`
- `ds-process-reasoning-entry`
- `ds-process-entry-summary`
- `ds-process-entry-title`
- `ds-process-reasoning-preview`
- `ds-process-entry-status`
- `ds-process-entry-detail`
- `ds-process-entry-detail-frame`
- `ds-process-entry-detail-note`
- `ds-process-entry-detail-actions`
- `ds-process-tool`
- `ds-process-tool-row`
- `ds-process-tool-row-summary`
- `ds-process-tool-row-summary-label`
- `ds-process-tool-row-summary-title`
- `ds-tool-diff-preview`
- `ds-tool-diff-preview-header`
- `ds-approval-block`
- `ds-approval-actions`
- `ds-plan-block`
- `ds-system-bubble`

Approval behavior:

- Buttons only render when `item.decision === undefined` and an approve handler
  exists.
- Pending decision is shared by `approvalId` across the timeline block and the
  composer-adjacent pending panel. Failed IPC responses release the pending
  state; successful responses stay disabled until the resolved `ApprovalItem`
  update reaches renderer state.
- File diff previews follow `showDiffByDefault` until the user manually opens or
  closes a preview; later re-renders do not overwrite that manual state.
- Unresolved approvals for the active thread also appear in a composer-adjacent
  pending approval panel, while the timeline block remains as the durable audit
  record.
- Pending approval auto-scroll is driven by the pending approval identity
  signature, not only by count, so replacing one pending approval with another
  still honors `autoScrollOnRequest`.

### Assistant Markdown

Component: `AssistantMarkdown`.

Renderer:

- Uses `react-markdown` and `remark-gfm`.
- Streaming text temporarily closes a dangling triple-backtick code fence so
  partial model output still renders as a code block while the turn is live.
- Links are normalized before render. `http(s)` links get `target="_blank"` and
  `rel="noreferrer"`; page anchors stay in-renderer; relative/local/unsafe
  protocols render as plain text instead of clickable anchors.
- Non-empty code blocks are wrapped in `ds-code-block`.
- Code language header is extracted from `language-*` class.
- Fenced code blocks render from the extracted source string inside the
  `ds-code-block` `<pre>`; empty or whitespace-only fenced blocks are skipped
  so a dangling or empty model fence cannot leave a blank code shell.
- Empty or whitespace-only inline code spans are rendered as plain text or
  omitted instead of creating visible placeholder pills.
- Long code blocks start collapsed with expand/collapse controls while short code
  blocks remain open. The line threshold comes from
  `basicPreferences.codeBlockCollapseLineThreshold`, and the expand/collapse
  control owns the rendered `<pre>` via `aria-controls`.
- Collapsed long code blocks show a preview note with the total line count so the
  bounded code area is not mistaken for the full block.
- Collapsed long code blocks render only a bounded source preview inside the
  `<pre>`. Expanding restores the full code node, and copy still uses the full
  source string.
- Code block copy controls keep a stable accessible label/title while the
  visible text can briefly show copied or failed state before returning to idle.
  Repeated copy attempts replace the previous feedback timer, and unmount clears
  any pending reset.
- Tables are wrapped in `ds-markdown-table-wrap`.
- Images are wrapped in `ds-markdown-image-frame`; only `http(s)` and supported
  image `data:` URLs are rendered, and rendered images use lazy loading plus
  async decoding.
- Task-list checkboxes use `ds-markdown-task-checkbox` and are disabled.

Key classes:

- `ds-markdown`
- `ds-shiny-markdown`
- `ds-markdown-tail-cursor`
- `ds-code-block`
- `ds-code-block-header`
- `ds-code-block-actions`
- `ds-markdown-table-wrap`
- `ds-markdown-image-frame`
- `ds-markdown-task-checkbox`
- `ds-markdown-divider`

### Floating Composer

Component: `FloatingComposer`.

Purpose:

- Edit and send prompt text for Code and Write variants.
- Interrupt in-flight turn.
- In the Code variant, add image attachments when Workbench Settings allows
  picker uploads.
- Paste image attachments directly from the clipboard when Workbench Settings
  allows clipboard image paste.
- Preview image attachments as thumbnails with an overlaid remove button.
- Attachment remove uses stable visible text plus localized `aria-label` /
  `title`, matching the error-toast control.
- Toggle plan mode and goal mode.
- Select model profile and reasoning effort.

Key classes:

- `ds-composer-shell`
- `ds-composer-toolbar`
- `ds-composer-toolbar-actions`
- `ds-composer-shell.is-code`
- `ds-composer-shell.is-write`
- `ds-composer-attachments`
- `ds-composer-attachment`
- `ds-composer-attachment-remove`
- `ds-composer-attachment-fallback`
- `ds-composer-toolbar-left`
- `ds-composer-tool-button`
- `ds-composer-popover`
- `ds-composer-menu-row`
- `ds-composer-model-button`

States:

- `sendPending`: local send guard.
- `runtimeBusy`: derived from the active thread's entry in
  `state.inFlightTurnsByThreadId`.
- `attachments`: thumbnail display records in `state.composer.attachments`;
  generated thumbnail data URLs live on `thumbnailUrl`, with `previewUrl` used
  only as an object-URL fallback when thumbnail generation fails. Authoritative
  ids live in `state.composer.attachmentIds`.
- Attachment removal is disabled while a send is pending or the active thread is
  running, so runtime attachment reads cannot race with composer cleanup.
- `menuOpen`, `pickerOpen`: popovers close on outside pointer down or Escape.
  The `+` and model buttons expose `aria-controls` only while their respective
  popovers are mounted.
- The `+` popover is a `role="menu"` surface; the image action is a menu item
  and plan/goal toggles are menuitemcheckbox rows.
- The model picker popover is exposed as a dialog and marks active model profile
  / reasoning effort buttons with pressed state, matching the visual `is-active`
  state.
- When enabled, clipboard paste filters to PNG/JPEG/WebP/GIF files, creates the
  same renderer attachment records as the picker path, generates a bounded
  thumbnail for the composer preview, and keeps normal text paste behavior when
  clipboard text is present. When disabled, clipboard image files are ignored
  before attachment processing and normal text paste remains untouched.
- Backspace/Delete removes the newest attachment only when the textarea is empty
  and removal is not disabled.
- Plan mode and goal mode menu rows expose active state with `aria-checked`,
  matching the visual `is-active` state and on/off text.
- The default Write variant hides attachment tray, image picker, `+` menu,
  plan/goal toggles and model picker. `WriteAssistantPanel` explicitly enables
  image attachments and model picking for writing requests while keeping
  plan/goal controls disabled, so its payload can carry `attachmentIds` but
  still uses `mode: "agent"` and `goalMode: false`.

Send behavior:

- Enter sends, Shift+Enter inserts newline.
- Enter is ignored while IME composition is active, so confirming
  Chinese/Japanese/Korean candidates cannot submit the draft accidentally.
- The textarea resets to `auto` height and then syncs to its `scrollHeight`
  after draft changes; CSS min/max height keeps the control bounded.
- Empty text is blocked unless attachments are present through the composer
  payload builder.
- New thread is created automatically when no active thread exists, after any
  Code MCP prompt/resource references have resolved successfully.
- Goal mode can create/update thread goal before starting a turn.
- Code sends resolve MCP inputs before automatic thread creation and
  `turn:start`: a leading
  `/mcp__<server>__<prompt>` is expanded through `agentApi.mcp.getPrompt()`,
  and `@<server>:<uri>` references append resource text through
  `agentApi.mcp.readResource()`. Resource URIs are parsed as non-whitespace
  tokens with only surrounding prose punctuation trimmed. The original draft
  stays in `displayText`, so the user bubble shows the command/reference
  instead of injected context.

### Right Inspector

Component: `RightInspector`.

Purpose:

- Show derived change/tool summaries using localized labels from the shared runtime tool catalog.
- Show pending todos.
- Show latest plan progress.

Layout:

- Class: `ds-right-inspector`.
- Region id: `workbench-right-inspector`.
- Region label id: `workbench-right-inspector-title`.
- Width: `state.rightSidebarWidth`.
- Clamp: `280..760`.
- Resizer class: `ds-right-inspector-resizer`.
- Resizer keyboard:
  - ArrowLeft expands.
  - ArrowRight shrinks.
  - Home jumps to min.
  - End jumps to max.
- Double click resets width to `RIGHT_INSPECTOR_DEFAULT_WIDTH`.
- Pointer resizing adds `is-dragging` to the resizer so the active drag line
  remains visible until pointer up/cancel.

Panels:

| Mode | Component | Content source |
| --- | --- | --- |
| `changes` | `ChangesPanel` | Recent tool item summaries with bounded detail previews. |
| `todo` | `TodoPanel` | Pending approvals, failed tools, error system items, incomplete latest-plan steps. |
| `plan` | `PlanPanel` | Latest `PlanItem`, progress meter, steps. |

Key classes:

- `ds-right-inspector-header`
- `ds-right-inspector-title`
- `ds-right-inspector-body`
- `ds-inspector-empty`
- `ds-inspector-change-list`
- `ds-inspector-detail-note`
- `ds-inspector-todo-list`
- `ds-inspector-plan`
- `ds-inspector-plan-meter`
- `ds-inspector-plan-steps`

Close control:

- Uses stable visible ASCII text with localized `aria-label` and `title`.

### Error Toast

Location:

- Code route: bottom composer area.
- Write route: floating bottom-right toast over the Write stage.

Class: `ds-error-toast`.

Source:

- `state.errorMessage`.
- Workbench preload IPC `IpcResult.err` values and rejected invoke promises are
  normalized into this state before display.
- The copy button writes the full current error message to the clipboard and
  shows transient copied / failed feedback without replacing the toast message.
- The dismiss button uses stable visible text plus localized `aria-label` and
  `title`; it must not depend on glyphs that can degrade under encoding issues.

Behavior:

- Uses `role="status"`.
- Copy failures stay visible through the button feedback state and are logged by
  the renderer handler.
- Dismiss button clears `actions.setError(null)`.
- Runtime and IPC failures should be routed here when visible to the user.

## Write Page

Implementation entry: `Workbench` when `state.route === "write"`.

### Layout

```mermaid
flowchart LR
  Sidebar["Write Sidebar"]
  WorkspaceBlock["Workspace controls"]
  Sessions["Writing sessions\nThreadSessionList"]
  Documents["Markdown documents"]
  Stage["WriteWorkbenchStage"]
  Workspace["WriteWorkspaceView"]
  Editor["WriteEditorPanel\nMarkdown Source"]
  Preview["Markdown Preview"]
  Ghost["Inline completion ghost"]
  Status["Save/status bar"]
  Assistant["WriteAssistantPanel\nWrite Assistant"]
  Messages["Grouped thread timeline"]
  Pending["Pending approvals"]
  Prompt["Explicit assistant input"]

  Stage --> Workspace
  Workspace --> Sidebar
  Sidebar --> WorkspaceBlock
  Sidebar --> Sessions
  Sidebar --> Documents
  Workspace --> Editor
  Workspace --> Preview
  Editor --> Ghost
  Editor --> Status
  Editor --> Assistant
  Assistant --> Messages
  Assistant --> Pending
  Assistant --> Prompt
```

Top-level:

- Shares `ds-stage-surface` from `Workbench`.
- `WriteWorkbenchStage` wraps `WriteWorkspaceView` and the floating error toast.
- `WriteWorkspaceView` renders its own sidebar inside the stage. The sidebar is
  organized as workbench navigation, workspace controls, writing sessions, and
  Markdown documents.
- `WriteWorkspaceView` owns document file list, active file, dirty content,
  completion, editor selection, save refs, autosave timers and Write IPC calls;
  `WriteEditorPanel` and `WriteAssistantPanel` receive controlled props and
  callbacks.
- Sidebar width uses the same `state.leftSidebarWidth`, and the Write route
  exposes its own `ds-workbench-divider ds-write-sidebar-divider` separator for
  pointer and keyboard resizing.
- Main area uses `ds-write-main`: editor remains the primary pane and the
  right assistant pane stays inside the Write route, not the Code composer.

### Write Sidebar

Purpose:

- Navigate back to Code route.
- Navigate to Settings.
- Pick/open workspace and select or create a `mode: "write"` thread for that
  workspace before file listing starts; if thread selection fails, the Write
  file list/editor state is not applied to that workspace and the Write status
  area surfaces the failure.
- Refresh markdown file list.
- Show active workspace.
- Show `mode: "write"` sessions by reusing the shared `ThreadSessionList`
  behavior for selecting, archiving, restoring and deleting threads.
- Create a new writing session with `mode: "write"` through the existing
  thread creation path. Switching or creating a writing session first flushes
  the current dirty Markdown document; if save fails, the session action does
  not proceed.
- Toggle archived session visibility with the same renderer preference used by
  the Code sidebar.
- Search markdown files.
- Search clear uses stable visible text plus localized `aria-label` / `title`,
  so the control does not depend on glyphs that can degrade under encoding
  issues.
- Create, rename and delete Markdown documents through the Write IPC file
  service.
- Display the document list, inline rename/delete confirmation states and
  right-click context menu actions.

Key classes:

- `ds-write-route-actions`
- `ds-write-sidebar-section`
- `ds-write-sidebar-section-header`
- `ds-write-sidebar-actions`
- `ds-write-sessions-section`
- `ds-write-session-list`
- `ds-write-documents-section`
- `ds-write-document-toolbar`
- `ds-write-document-form`
- `ds-pill`
- `ds-sidebar-workspace ds-write-workspace-label`
- `ds-write-search`
- `ds-write-search-clear`
- `ds-write-document-list`
- `ds-sidebar-empty`
- `ds-write-file-row`
- `ds-write-file-row-main`
- `ds-write-file-actions`
- `ds-write-file-action`
- `ds-write-file-delete-confirm`
- `ds-write-context-menu`

List states from `getWriteListState()`:

| State | Condition |
| --- | --- |
| `loading` | File list request is in flight. |
| `no-workspace` | No workspace root selected. |
| `ready` | Files array has entries. |
| `empty-search` | No files match non-empty search. |
| `empty` | Workspace selected but no markdown files found. |

File row attributes:

- Active file: `is-active`.
- Active file button uses `aria-current="page"`.
- Pending delete confirmation: `is-confirming-delete`.
- Create, rename and delete operations expose `is-busy` / `aria-busy` on the
  affected row while the IPC call is in flight.
- Title includes path and formatted file meta.
- Meta format: `formatWriteFileMeta()` => size, stable `|` separator, and
  modified date.
- Right-clicking a document row opens rename/delete/create actions. Right-clicking
  empty list space opens create only.
- `getWriteContextMenuPosition()` clamps the context menu against the viewport
  margin, so menu actions remain reachable near the right and bottom edges.

### Editor Area

Purpose:

- Edit markdown content.
- Preview rendered markdown content beside the source editor.
- Autosave changed file content.
- Request simple inline markdown completion around the current editor
  selection/caret.
- Accept completion with Tab, dismiss with Escape.

Key classes:

- `ds-write-workspace`
- `ds-write-sidebar`
- `ds-write-sidebar-divider`
- `ds-write-main`
- `ds-write-editor`
- `ds-write-editor-split`
- `ds-write-editor-frame`
- `ds-write-preview`
- `ds-write-preview-controls`
- `ds-write-preview-empty`
- `ds-write-ghost`
- `ds-write-status`
- `ds-write-status-message`
- `ds-write-save-button`

Behavior constants:

- Autosave delay: `800ms`.
- Completion delay: `650ms`.
- Completion requires at least `10` characters before the current caret or
  selection start, so long documents do not request completions from an empty
  or near-empty prefix.
- Main Markdown textarea has an `aria-label` that matches its localized editor
  placeholder.
- Source editing uses a hybrid textarea boundary: user typing updates Write
  state through `onChange`, but React does not push the whole Markdown string
  back into the DOM on every keystroke. Programmatic changes such as opening a
  different file or accepting inline completion still synchronize the textarea.
- Large source documents enter `data-source-mode="large-document"` and disable
  soft wrapping, spellcheck, autocomplete and autocapitalize so the browser does
  less layout and text-assist work while editing.
- The Markdown preview reuses the same safe renderer used by assistant
  messages, including code block controls, GFM tables/task lists and
  link/image safety rules.
- Preview rendering is snapshot-based. Small documents update live, medium
  documents update after typing pauses, and very large documents pause automatic
  preview rendering until the user explicitly refreshes the preview. This keeps
  `react-markdown` / `remark-gfm` parsing off the per-keystroke path.
- Inline completion is positioned near the current caret line and shows the
  localized Tab/Escape hint.
- Inline completion requests send only bounded text around the current
  caret/selection rather than slicing and sending the whole document prefix and
  suffix.
- Inline completion responses are request-id, workspace and active-path
  guarded, so late responses from an older file, workspace or caret context are
  ignored before they can replace the visible ghost text.
- Accepting inline completion restores the editor selection to the inserted
  completion boundary, keeping the caret near the accepted text instead of
  falling back to the end of the document.
- Sidebar width/flex-basis remains a dynamic inline style sourced from
  `state.leftSidebarWidth`; static sidebar colors, borders, action spacing and
  status layout live in `shell.css`.
- Opening another file or refreshing/switching workspace first flushes the
  current dirty file through `write.put`; if that save fails, navigation stays
  on the current file and surfaces the error.
- Switching workspace clears the previous workspace file list and active file
  immediately, so a failed list request cannot leave stale file-relative state
  under the new workspace root.
- File open, file clear and workspace-switch flows share the same document view
  state helpers, keeping active path, source text, saved text, completion and
  editor selection reset from diverging across those branches.
- Open-file responses are request-id guarded, so a slower `write.get` response
  from an earlier click cannot overwrite the later active file.
- Rejected `write.get` and inline completion IPC calls surface through the
  Write status error path instead of becoming unhandled renderer promises.
- Manual workspace open/refresh cancels any pending debounced search reload, so
  a stale search timer cannot repopulate the file list after a workspace
  boundary change.
- Creating, renaming or deleting a non-active document first flushes the current
  dirty document through `write.put`; if that save fails, the
  document-management action does not proceed. Deleting the active document
  skips that pre-delete save because the inline confirmation is the user's
  explicit discard decision for that file.
- New and renamed document paths are normalized to workspace-relative forward
  slashes, repeated separators are collapsed, individual path segments are
  trimmed, and paths with `.` / `..` segments, drive roots, trailing separators,
  empty Markdown filenames or non-Markdown extensions are rejected before IPC.

### Write Assistant

Purpose:

- Send explicit writing requests from the Write route through the active
  `mode: "write"` thread.
- Display grouped Write thread timeline turns, including user input, work
  process entries, reasoning, tool records, approvals, plans, system messages
  and assistant responses.
- Show current pending approvals next to the Write composer, reusing the same
  approval card, diff preview and allow/deny submission state as the Code route.
- Include current Markdown file path, save state and explicit local context in
  the prompt. Selected text is sent only when the user selects it; otherwise a
  bounded nearby snippet may be sent. The full document body is not mirrored
  into the global Code composer.

Key classes:

- `ds-write-assistant`
- `ds-write-assistant-header`
- `ds-write-assistant-messages`
- `ds-write-assistant-timeline`
- `ds-write-assistant-empty`
- `ds-write-assistant-composer`
- `ds-composer-shell.is-write`

Behavior:

- Submit is handled by `FloatingComposer variant="write"` and is enabled only
  when there is an open workspace, text or image attachments to send, and no
  active Write assistant turn.
- The Write assistant composer supports normal text paste, image paste/upload
  when Workbench attachment settings allow it, attachment thumbnails and quick
  model profile/reasoning selection. Plan and goal controls remain hidden.
- `Workbench` sends Write assistant turns with the composer `attachmentIds`,
  `mode: "agent"`, and `goalMode: false`; it clears composer attachments after
  a successful send and does not read the global Code composer draft as the
  prompt source.
- Write assistant scrolling follows the same bottom-stickiness behavior as the
  Code timeline: live output auto-follows only while the user remains near the
  bottom, otherwise a jump-to-latest control appears.
- The recent assistant item window preserves the complete leading turn at the
  truncation boundary, so the grouped timeline does not start in the middle of
  a user/process/assistant sequence.
- Read-only tool record visibility follows
  `runtimePreferences.approvalExperience.showReadOnlyToolRecords`; failed tool
  records remain visible.
- The assistant may suggest text or guidance, but current Write IPC file
  services remain renderer-owned; model replies do not directly save Markdown
  files.
- `write.get`, `write.put`, `write.create`, `write.rename`, `write.delete` and
  inline completion only accept Markdown file paths (`.md`, `.mdx`,
  `.markdown`), matching the file list.
- `write.get` returns only strict UTF-8 Markdown content; invalid local bytes
  surface as a visible load error instead of replacement-character text.
- Editing content or accepting inline completion only updates local Write
  document state. It does not overwrite global `composer.text`.

Save state:

| Status | Meaning |
| --- | --- |
| `idle` | No active load/save operation. |
| `loading` | Listing or opening content. |
| `saving` | `write.put` in flight. |
| `saved` | Save completed; status clears after 1500ms. |
| `error` | File operation or completion failed. |

Save button disabled when:

- No active file.
- No workspace root.
- Status is `loading` or `saving`.
- Content equals saved content.

## Settings Page

Implementation entry: `SettingsView` when `state.route === "settings"`.

### Layout

```mermaid
flowchart LR
  Sidebar["SettingsSidebar"]
  Main["Settings Main"]
  Header["Page header + status/actions"]
  Tabs["Six section tabs"]
  Content["SettingsCard content"]

  Sidebar --> Main
  Main --> Header
  Header --> Tabs
  Main --> Content
```

Top-level:

- Root class: `ds-settings-root`.
- Sidebar component: `SettingsSidebar`.
- Main form class: `ds-settings-main`.
- Content wrapper: `ds-settings-content`.
- Header class: `ds-settings-page-header`.

### Settings Navigation

Sections:

- `basic`
- `model`
- `agent`
- `tools`
- `workbench`
- `visibility`

Section tabs:

- Class: `ds-settings-section-tabs`.
- Buttons: `ds-settings-section-tab`.
- Active button gets `is-active` and `aria-pressed`.

Sidebar category nav:

- Class: `ds-settings-nav`.
- Buttons: `ds-settings-nav-item`.
- Active category gets `is-active` and `aria-current="page"`.
- The sidebar includes a `show advanced settings` switch. When it is off, core
  categories stay visible and advanced runtime/model/tool tuning categories are
  filtered out before text search is applied.

Search:

- The sidebar search is scoped to the active top-level section.
- Results remain category-level so the two-level Settings structure stays
  stable.
- Matching includes category label/description/id plus the labels,
  descriptions, and main option text for settings owned by that category.

Category ownership:

| Section | Categories | Persistence / consumer |
| --- | --- | --- |
| `basic` | `appearance` | Renderer `basicPreferences` localStorage, i18n and theme helpers. |
| `model` | `profiles`, `connection`, `context`, `reasoning` | Main `ModelConfigStore` through `modelConfig.*` IPC. |
| `agent` | `compaction`, `skills` | Config-backed `RuntimePreferencesStore`; consumed by `AgentRuntime.prepareMessagesForRequest()` and `SkillService` turn resolution. |
| `tools` | `permissions`, `mcpServers`, `toolAccess`, `commandLimits` | Config-backed `RuntimePreferencesStore`; consumed by thread creation, MCP host configuration, tool catalog filtering and command-backed tools. |
| `workbench` | `startup`, `layout`, `session`, `modelDefaults`, `attachments` | Renderer `basicPreferences` for UI-only fields and composer attachment entry points; config-backed `RuntimePreferencesStore` for Code/Write default model profile ids. |
| `visibility` | `approvalPresentation` | Config-backed `RuntimePreferencesStore`; consumed by approval/timeline/toast presentation in renderer. |

Model categories:

- `profiles`
- `connection`
- `context`
- `reasoning`

Agent Behavior categories:

- `compaction`
- `skills`

Tools And Permissions categories:

- `permissions`
- `mcpServers`
- `toolAccess`
- `commandLimits`

MCP Servers category:

- Configures `RuntimePreferences.mcpServers` through the same runtime
  preferences save queue as other tool settings.
- Add creates a collision-free default server name using the same
  `toMcpNameSegment()` namespace rule as the main-process preferences parser,
  so an unsaved duplicate default draft does not fail the strict save path.
- Supports `stdio` command/args/cwd/env fields and `streamable-http` URL/header
  fields. Header/env textareas parse JSON objects and surface validation errors
  through the settings status area.
- Displays live status from `agentApi.mcp.listServers()` plus
  `mcp_server_connection`, `mcp_tool_list_changed`, and `mcp_surface_changed`
  SSE events. Status labels include connected lifecycle states plus `cached`
  and `lazy` when schema comes from the MCP cache while a live reconnect is
  pending or failed.
- Shows tools/prompts/resources counts and compact name lists for each server,
  `lastError` diagnostics, startup stats when available, plus connect,
  disconnect, refresh tools, refresh surface, delete and add actions.

Workbench Settings categories:

- `startup`
- `layout`
- `session`
- `modelDefaults`
- `attachments`

Notifications And Visibility categories:

- `approvalPresentation`

Navigation guard:

- `ensureNoUnsavedProfileChanges()` blocks section/profile navigation while
  model profile state is dirty.
- Sidebar category navigation uses the same guard, so switching among model
  subcategories cannot discard unsaved profile edits.

### Basic Settings

Appearance:

- Locale selector.
- Theme segmented control: light/dark.
- Follow system theme toggle.

State sink:

- Basic settings update `basicPreferences` in `WorkbenchContext`.
- Persisted with `saveBasicPreferences()`.
- Locale and theme go through `i18n`, `persistLocale()`, `setTheme()`, and
  `setFollowSystemTheme()`.
- When follow-system theme is enabled, the renderer listens to
  `prefers-color-scheme` changes and keeps `<html data-theme>` in sync until a
  manual light/dark selection disables follow mode.

### Workbench Settings

Startup:

- Default startup view: `code | write`.

Layout:

- Remember left sidebar width.
- Remember right sidebar width.
- Default inspector mode: none, changes, todo, plan.
- Code block fold line count.
- Open completed reasoning by default.

Session:

- Show archived threads by default.
- Restore last workspace on startup.
- Thread deletion confirmation is not configurable here; the Sidebar always
  uses inline confirmation before calling the delete API.

Model defaults:

- Code default model profile id.
- Write default model profile id.
- Empty selection means "use active profile"; runtime falls back to active/first
  profile if a saved default profile id no longer exists.

Attachments:

- Allow composer image upload: controls whether the `+` menu shows the image
  picker row and whether stale file input changes can enter attachment
  processing.
- Allow composer image paste: controls whether clipboard image files can become
  composer attachments. Regular text paste behavior is not blocked.

State sinks:

- Startup, layout and session settings update renderer `basicPreferences` and
  localStorage.
- The code block fold line count is consumed by `ChatBlock` / `AssistantMarkdown`
  when rendering assistant and reasoning Markdown.
- The completed reasoning default-open preference is consumed by `ChatBlock`;
  live reasoning still opens while streaming.
- Attachment settings update renderer `basicPreferences` and are consumed by
  `FloatingComposer`.
- Model defaults update `runtimePreferences` through
  `window.agentApi.runtimePreferences.update()`.
- The composer keeps `modelProfileSelection: "auto" | "explicit"` so the model
  label can follow the active profile while turn requests omit `modelProfileId`
  unless the user explicitly picked a profile. This preserves config-backed
  Code/Write default model profiles.
- After deleting a model profile, Settings refreshes `runtimePreferences` so
  Code/Write default profile selects reflect main-process cleanup. If that
  refresh fails, the renderer locally clears defaults pointing at the deleted
  profile and surfaces the runtime preference error.
- After activating a model profile, Settings also refreshes `runtimePreferences`
  for UI freshness. If that refresh fails, the renderer keeps the current
  runtime preference object instead of applying the delete-profile fallback,
  because activation does not invalidate existing Code/Write default profile ids.
- Runtime preference controls are disabled while the runtime preference load or
  save state is `loading` / `saving`, and when the preload API is unavailable.
- Runtime preference saves are serialized in renderer: if another runtime
  preference change arrives while one save is in flight, Settings deep-merges it
  into a pending update and flushes it after the active save settles.

### Model Settings

Profiles:

- Profiles load through `modelConfig.listProfiles()` when Settings mounts.
- Profile loading is not tied to locale/theme preference changes; changing
  basic settings must not refresh the active model form or overwrite unsaved
  profile edits.
- Add MiniMax profile.
- Add DeepSeek profile.
- Add custom profile.
- Activate, duplicate, delete profiles.
- Two-step delete confirmation through `pendingDeleteProfileId`.
- Pending delete confirmation is pruned when the backing profile disappears from
  the current profile list.

Connection:

- Profile name.
- Provider name.
- Model id.
- Protocol: `openai-compatible | anthropic-compatible`.
- Base URL.
- API key via `SecretInput`.

Context:

- Model context window.
- Auto compact token limit.
- Max output tokens.

Reasoning:

- Thinking toggle.
- Reasoning effort select.
- Agent autonomy select.

Save state:

| State | UI meaning |
| --- | --- |
| `loading` | Initial profile load. |
| `idle` | Loaded and clean. |
| `dirty` | Unsaved model profile edits. |
| `saving` | Profile operation in flight. |
| `saved` | Last profile operation succeeded. |
| `error` | Handler returned error or local validation failed. |

Navigation guard treats `dirty` as unsaved, and also treats `error` as unsaved when the current form still differs from the active profile after a failed save. The guard applies to section tabs, sidebar categories, profile actions, and returning to the workbench.

Primary save button:

- Only visible for model section.
- Disabled when no preload API, loading, saving, idle, or saved.
- Submit calls `modelConfig.updateProfile` only from model configuration
  categories (`connection`, `context`, `reasoning`); the profile list category
  cannot submit the outer Settings form.
- Active model profile cards use `is-active`; the card's main button also uses
  `aria-current="true"` while it represents the active profile.
- Model profile input controls are disabled when the preload API is unavailable,
  while profile data is loading/saving, and while create/activate/duplicate/delete
  profile operations are busy. This prevents delayed profile responses from
  replacing newer unsaved edits in the form.

### Agent Behavior

Compaction:

- Automatic compaction toggle.
- Strategy select: `balanced`, `recent-only`, `preserve-tools`, `aggressive`.
- Disabling automatic compaction still keeps hard context-window enforcement in
  runtime.

Skills:

- Enable/disable workspace, custom and built-in skill discovery.
- Active skill limit numeric input controls how many matched skills can inject
  turn context.
- Instruction budget numeric input controls the UTF-8 byte budget for injected
  skill instructions.
- Extra roots textarea accepts one path per line; relative paths resolve inside
  the active workspace.
- Discovered skills panel calls `agentApi.skills.list({ workspace })` for the
  current workspace and displays compact catalog stats, scan roots, validation
  warnings, scope/run mode labels, trigger summaries, allowed tools and reference
  names. The panel is read-only and does not render full `SKILL.md` bodies or
  reference contents.

### Tools And Permissions

Permissions:

- Default approval policy for newly created threads.
- Default sandbox mode for newly created threads.
- Per-call permission rules table with tool type, pattern, effect and delete
  controls. The add button creates a command rule draft; pattern edits commit
  on blur or Enter and schema errors surface in the shared runtime settings
  error notice.

Tool access:

- Per-tool switches for Code and Write runtime catalogs.
- Disabled tools are omitted from model tool definitions; forced calls are
  rejected by runtime.
- Write mode keeps Code-only tools disabled by default.

Command limits:

- Command timeout in milliseconds.
- Command output byte limit.
- Values are validated by shared runtime preference bounds before persistence.
- Number fields keep local draft text while the user edits. Blur or Enter
  validates and saves; Escape restores the current persisted value.

### Notifications And Visibility

Approval presentation:

- Open approval diffs by default.
- Scroll pending approvals into view.
- Show or hide successful read-only tool process records; failed read-only tool
  records remain visible so tool errors stay traceable in the timeline.
- Show or suppress runtime failure toasts.

### Settings Primitives

Components:

- `SettingsSidebar`
- `SettingsCard`
- `SettingRow`
- `StatusBadge`
- `Toggle`
- `SecretInput`

Common classes:

- `ds-settings-sidebar`
- `ds-settings-card`
- `ds-setting-row`
- `ds-status-badge`
- `ds-toggle`
- `ds-secret-input`

## UI Token Reference

Token source: `src/renderer/src/ui/styles/tokens.css`.

Common token groups:

- Backgrounds: `--ds-bg-main`, `--ds-bg-sidebar`, `--ds-bg-surface`,
  `--ds-bg-elevated`.
- Text: `--ds-text-primary`, `--ds-text-secondary`, `--ds-text-faint`,
  `--ds-text-placeholder`.
- Borders: `--ds-border-muted`, `--ds-border-strong`.
- Status: `--ds-danger`, `--ds-danger-soft`, success/warning tokens when
  available in CSS.
- Radius: `--ds-radius-sm`, `--ds-radius-md`, `--ds-radius-lg`.
- Type: `--ds-size-caption` and neighboring size tokens.

Styling rules:

- Prefer `--ds-*` variables over raw hex in component styles.
- Keep cards for repeated/framed content; route sections stay structural.
- Resizable fixed-format UI uses clamped dimensions from `preferences.ts`.
- Renderer must not access filesystem directly; UI file operations go through
  `window.agentApi.write` and `window.agentApi.workspace`.

## Route Interaction Summary

```mermaid
flowchart TD
  Code["Code route"]
  Write["Write route"]
  Settings["Settings route"]
  Workspace["workspaceRoot"]
  Threads["Thread list / active thread"]
  Composer["Composer state"]
  Preferences["basicPreferences"]
  ModelProfiles["modelProfiles"]
  RuntimePreferences["runtimePreferences"]

  Code --> Workspace
  Code --> Threads
  Code --> Composer
  Code --> ModelProfiles
  Write --> Workspace
  Write --> Threads
  Settings --> Preferences
  Settings --> ModelProfiles
  Settings --> RuntimePreferences
  Settings --> Code
  Write --> Code
  Code --> Settings
```

Cross-route coupling:

- Code and Write share `workspaceRoot` and left sidebar width.
- Code and Write share the thread list state, but route actions prefer threads
  whose `ThreadRecord.mode` matches the active route.
- Write document text is isolated from global composer draft state. Assistant
  prompts must come from explicit composer input, not implicit full-document
  mirroring.
- Settings model profile changes update `modelConfig`, `modelProfiles`, and
  composer model selection.
- Basic settings can change startup route, inspector default, sidebar width
  persistence, archived-thread visibility, and message display defaults.
- Runtime preference settings can change Code/Write default model profiles,
  approval/sandbox defaults for newly created threads, tool catalog visibility,
  command defaults, compaction strategy and approval presentation behavior.

## Documentation Maintenance Checklist

Update this document when changing:

- Route names or route ownership.
- `WorkbenchState`, `ComposerState`, or basic preference fields.
- Sidebar or inspector width constants.
- Page-level layout classes.
- Settings categories/sections.
- New renderer-visible IPC groups or page workflows.
- CSS token names used by core layout.

For documentation-only edits, verify:

```bash
rg "WorkbenchContext|SettingsView|WriteWorkspaceView|RightInspector" docs/ui-layout-reference.md
git diff --check
```

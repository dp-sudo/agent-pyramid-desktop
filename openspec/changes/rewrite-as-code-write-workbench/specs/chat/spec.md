## ADDED Requirements

### Requirement: Thread list in sidebar

The chat workbench SHALL display a sidebar listing all threads belonging to the active route (`chat` or `write`), ordered by most recent activity. The list MUST include the thread title, last-updated timestamp, and an indicator when the thread is busy.

#### Scenario: List is sorted by recency
- **WHEN** the user opens the chat workbench
- **THEN** the sidebar MUST list threads with the most recently active thread at the top

#### Scenario: Busy indicator
- **WHEN** a thread has an in-flight turn
- **THEN** the sidebar row MUST show a busy indicator next to its title

### Requirement: Message timeline with typed blocks

The chat center column MUST render the active thread's items as a vertical timeline. Each item MUST be rendered by a block component matching its `kind` (user, assistant, reasoning, tool, compaction, approval, user_input, system). The timeline MUST virtualize the list when item count exceeds 200.

#### Scenario: User message renders as bubble
- **WHEN** a `user` item is in the timeline
- **THEN** the system MUST render it as a right-aligned bubble using `--ds-bubble-user` background and `--ds-bubble-user-fg` text color

#### Scenario: Assistant message renders with streaming shimmer
- **WHEN** the active thread is streaming and a live `assistant` partial is present
- **THEN** the renderer MUST apply the `ds-shiny-text` animation to the partial text

#### Scenario: Tool block displays invocation detail
- **WHEN** a `tool` item with `toolCallId`, `name`, `args`, and `result` fields is in the timeline
- **THEN** the system MUST render a collapsible block showing the tool name, args summary, and a result preview

### Requirement: Approval gate renders inline

When the runtime emits an `approval_requested` event with `toolName`, `args`, and `approvalId`, the chat timeline MUST render an approval block with `Allow` and `Deny` actions. The block MUST remain pending until the user acts.

#### Scenario: User allows
- **WHEN** the user clicks `Allow` on a pending approval
- **THEN** the system MUST POST `approval.respond` with `{ approvalId, decision: 'allow' }` and the block MUST transition to an `allowed` visual state

#### Scenario: User denies
- **WHEN** the user clicks `Deny` on a pending approval
- **THEN** the system MUST POST `approval.respond` with `{ approvalId, decision: 'deny' }` and the block MUST transition to a `denied` visual state

### Requirement: Floating composer

The chat workbench MUST provide a floating composer at the bottom of the center column. The composer MUST include a textarea, a model selector, a submit button, a queued-messages list, and an interrupt button.

#### Scenario: Submit on Enter
- **WHEN** the user types text into the composer and presses Enter
- **THEN** the system MUST send a `turn.start` request with the text and clear the composer

#### Scenario: Interrupt running turn
- **WHEN** a turn is in-flight and the user clicks the interrupt button
- **THEN** the system MUST POST `turn.interrupt` and the timeline MUST mark the in-flight items as interrupted

#### Scenario: Queue message while busy
- **WHEN** a turn is in-flight and the user submits another message
- **THEN** the system MUST append the message to `queuedMessages` and render a queued chip in the composer; the queued message MUST be sent automatically when the in-flight turn ends

### Requirement: Right inspector with mode switcher

The chat workbench MUST support a right inspector panel that can be opened in one of these modes: `changes`, `todo`, `plan`, `file`, `inspector-close`. The mode MUST persist to `localStorage` under `agent.workbench.rightPanelMode`.

#### Scenario: Open changes inspector
- **WHEN** the user clicks the changes button in the topbar
- **THEN** the inspector MUST show file changes derived from the thread's `tool` items, grouped by file path with `--ds-diff-added` / `--ds-diff-removed` coloring

#### Scenario: Inspector collapsed by default
- **WHEN** the user opens the chat workbench for the first time
- **THEN** the right inspector MUST be hidden until the user explicitly opens a mode

### Requirement: Topbar with session header and actions

The chat workbench MUST render a topbar above the timeline containing: a sidebar toggle button (when sidebar is collapsed), a session header (thread title + workspace root), and a right-aligned action cluster (busy indicator, right panel buttons).

#### Scenario: Topbar reflects active thread
- **WHEN** the active thread changes
- **THEN** the topbar's session header MUST update to show the new thread's title within 100ms

## ADDED Requirements

### Requirement: Drag-resizable sidebar
The sidebar MUST be resizable via a drag handle on its right edge. Width MUST be persisted to `localStorage` under `agent.workbench.leftSidebarWidth`.

#### Scenario: Drag updates width
- **WHEN** the user drags the sidebar's right edge handle
- **THEN** the sidebar width MUST update live (within 16ms per pointer move) and the layout MUST not reflow adjacent panels until the drag ends

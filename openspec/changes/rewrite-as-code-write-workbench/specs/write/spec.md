## ADDED Requirements

### Requirement: Markdown editor with autosave

The write workbench MUST provide a Markdown editor that autosaves to the active file path. The editor MUST debounce save by 800ms after the last keystroke and MUST show a `saving | saved | error` status indicator.

#### Scenario: Autosave after edit
- **WHEN** the user types a character and pauses for 800ms
- **THEN** the system MUST call `write.put` with the new content and update the status indicator to `saved` on success

#### Scenario: Save failure shows error
- **WHEN** `write.put` returns `{ ok: false, message: '...' }`
- **THEN** the status indicator MUST show `error` and the user-visible error message MUST be the message from the response

### Requirement: Inline completion

The write editor MUST request an inline completion when the user pauses typing for 650ms. The completion MUST be a ghost-text overlay that the user can accept with `Tab` or dismiss with `Escape`.

#### Scenario: Ghost text appears
- **WHEN** the user pauses typing for 650ms and the editor has ≥ 10 trailing characters
- **THEN** the system MUST call `write.complete` and render the returned completion as a low-opacity overlay

#### Scenario: Accept with Tab
- **WHEN** ghost text is visible and the user presses Tab
- **THEN** the ghost text MUST be inserted at the cursor and `write.complete` MUST be considered consumed

#### Scenario: Debounce during fast typing
- **WHEN** the user types continuously without pausing
- **THEN** the editor MUST NOT call `write.complete` more than once per 650ms window

### Requirement: Quoted selection agent

The write editor MUST allow the user to select a text range and invoke an inline agent (`/agent` slash command or toolbar button) that returns Markdown edits. The edits MUST be presented as a diff with `Apply` and `Discard` actions.

#### Scenario: Apply diff
- **WHEN** the user clicks `Apply` on a pending diff
- **THEN** the editor MUST replace the selected range with the agent's returned Markdown

#### Scenario: Discard diff
- **WHEN** the user clicks `Discard` on a pending diff
- **THEN** the editor MUST close the diff panel without modifying the document

### Requirement: Write workspace sidebar

The write workbench MUST show a sidebar listing the active workspace's Markdown files. The list MUST support a text search filter.

#### Scenario: Filter by search
- **WHEN** the user types into the sidebar's search input
- **THEN** the file list MUST filter to only paths containing the search substring (case-insensitive)

#### Scenario: Open file
- **WHEN** the user clicks a file in the sidebar
- **THEN** the editor MUST call `write.get` for that path and replace the editor content

## ADDED Requirements

### Requirement: Write assistant right panel
The write workbench MUST provide a right-side assistant panel that, when opened, shows a chat-style thread scoped to the active document. Sending a message MUST call `turn.start` with the document path attached as context.

#### Scenario: Send message with context
- **WHEN** the user sends a message in the write assistant panel
- **THEN** the system MUST include the active document path and a 2000-character excerpt as a `fileReferences` field in the turn request

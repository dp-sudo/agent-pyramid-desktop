## ADDED Requirements

### Requirement: Write workbench has an authoritative state model
The system SHALL keep Write editor state in a dedicated `WriteWorkspaceState` independent of the global composer.

#### Scenario: Write state tracks document and assistant state separately
- **WHEN** the user opens or edits a Markdown file in Write
- **THEN** active file, content, saved content, dirty state, save status, selection, recent edits, completion state, and assistant draft MUST be represented in `WriteWorkspaceState`
- **AND** the global composer text MUST NOT be rewritten with document content

#### Scenario: Workspace switch clears file-relative state
- **WHEN** the Write route changes workspace
- **THEN** active file, content, saved content, selection, recent edits, and completion text MUST be cleared before listing the new workspace files

### Requirement: Write assistant turns use scoped writing context
The system SHALL send Write assistant messages to `mode: "write"` threads with structured context from the current writing state.

#### Scenario: Assistant input reuses the composer surface
- **WHEN** the Write assistant renders its prompt input
- **THEN** it MUST reuse the shared composer input surface for draft entry, Enter-to-send, pending state, send button, and interrupt behavior
- **AND** it MUST bind that surface to Write-specific draft state instead of global Code composer state

#### Scenario: Assistant prompt display remains explicit
- **WHEN** the user sends a Write assistant request
- **THEN** the timeline display text MUST show the user request rather than the injected context payload

#### Scenario: Assistant payload includes editor context
- **WHEN** a Write assistant request is sent with an active file
- **THEN** the model-facing text MUST include the active file path, dirty state, current selection, cursor-near snippets, and recent edit summaries
- **AND** the payload MUST NOT require Code tools to inspect the file

#### Scenario: Empty assistant prompts are ignored
- **WHEN** the Write assistant draft is empty or whitespace
- **THEN** no turn MUST be started

### Requirement: Inline completion remains editor-scoped
The system SHALL keep local inline completion state inside the Write workspace model.

#### Scenario: Markdown editor uses an editor kernel
- **WHEN** the user edits a Write Markdown file
- **THEN** the editor MUST use a dedicated editor kernel rather than a plain textarea
- **AND** editor document and selection updates MUST flow through `WriteWorkspaceState`

#### Scenario: Completion is accepted at the cursor
- **WHEN** a local completion is accepted
- **THEN** the completion MUST be inserted at the current cursor or selection end
- **AND** the global composer text MUST NOT change

#### Scenario: Completion request uses prefix and suffix
- **WHEN** the renderer requests local Write completion
- **THEN** it MUST send the text before and after the current cursor rather than assuming the cursor is always at the end of the document

### Requirement: Future Write AI actions remain separate from Code tools
The system SHALL define future Write AI actions as Write-specific contracts rather than Code tool calls.

#### Scenario: Inline edit requires scoped replacement
- **WHEN** future inline edit is implemented
- **THEN** model output MUST be parsed as a scoped action and MUST be shown as a diff before applying

#### Scenario: Write memory is observable
- **WHEN** future writing memory or RAG retrieval is implemented
- **THEN** the UI MUST expose lightweight evidence about matched snippets and source files

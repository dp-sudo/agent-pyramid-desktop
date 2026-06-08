## ADDED Requirements

### Requirement: Workbench route determines thread mode
The system SHALL create or select threads whose `mode` matches the active workbench route when starting a new assistant turn from the renderer.

#### Scenario: Write route creates Write thread
- **WHEN** the active route is `write` and the user sends a prompt without an active thread
- **THEN** the renderer MUST create the new thread with `mode: "write"`

#### Scenario: Code route creates Code thread
- **WHEN** the active route is `code` and the user sends a prompt without an active thread
- **THEN** the renderer MUST create the new thread with `mode: "code"`

#### Scenario: Workspace selection respects route
- **WHEN** the user picks a workspace from the Write route
- **THEN** the renderer MUST prefer an active Write thread for that workspace instead of selecting a Code thread

### Requirement: Write document content is isolated from composer prompts
The system SHALL keep Write document editing state separate from the global assistant composer draft.

#### Scenario: Editing Write document does not rewrite composer
- **WHEN** the user edits or accepts a local completion in the Write editor
- **THEN** the global composer text MUST NOT be replaced by the document content

#### Scenario: Assistant prompts are explicit
- **WHEN** the user sends a Write assistant prompt
- **THEN** the prompt text MUST come from explicit assistant input rather than implicit full-document mirroring

### Requirement: Code-only tools are blocked in Write threads
The runtime SHALL NOT expose or execute Code-only tools in Write threads.

#### Scenario: Write thread tool list excludes coding tools
- **WHEN** the runtime builds tool definitions for a turn whose thread has `mode: "write"`
- **THEN** the tool definitions MUST NOT include `edit_file`, `write_file`, `apply_patch`, or `rollback_file`

#### Scenario: Write thread tool list excludes command tools
- **WHEN** the runtime builds tool definitions for a turn whose thread has `mode: "write"`
- **THEN** the tool definitions MUST NOT include `run_command`, `diagnose_workspace`, or `diagnose_file`

#### Scenario: Write thread rejects forced Code tool call
- **WHEN** a model response in a Write thread requests `edit_file`, `write_file`, `apply_patch`, `rollback_file`, `run_command`, `diagnose_workspace`, or `diagnose_file`
- **THEN** the runtime MUST mark that tool item failed with a traceable unavailable-tool message and MUST NOT execute the tool implementation

### Requirement: Code tools remain available in Code threads
The runtime SHALL preserve existing Code-thread tool behavior for coding and command workflows.

#### Scenario: Code thread keeps coding tools
- **WHEN** the runtime builds tool definitions for a normal Code agent turn
- **THEN** the tool definitions MUST still include registered coding tools and command tools according to existing approval and sandbox policy

#### Scenario: Code tool approval policy remains authoritative
- **WHEN** a Code thread requests a destructive coding or command tool
- **THEN** the runtime MUST apply the existing approval and sandbox policy before execution

### Requirement: Write file services remain renderer IPC services
Write file operations SHALL remain renderer-invoked Write services and SHALL NOT be exposed to the model as Code coding tools.

#### Scenario: Write editor saves through Write IPC
- **WHEN** the Write editor saves Markdown content
- **THEN** it MUST call `window.agentApi.write.put` or its Write-specific successor rather than model tool calls such as `write_file`

#### Scenario: Write IPC path policy remains separate
- **WHEN** a Write IPC request reads or writes a Markdown file
- **THEN** it MUST continue to use the Write service path policy and Markdown file restrictions

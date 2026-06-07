## ADDED Requirements

### Requirement: Multi-turn orchestration

The main-process runtime MUST support running a thread as a sequence of turns. A turn MUST consume the thread's prior items plus a new user message, invoke the LLM, execute any tool calls the model requests, and append the resulting items to the thread. The runtime MUST reject new turn starts for a thread that already has an in-flight turn with `RUNTIME_TURN_BUSY`.

#### Scenario: First turn of a new thread
- **WHEN** the user calls `turn.start` on a thread with no prior turns
- **THEN** the runtime MUST invoke the LLM with the system prompt and the user's message, append the assistant response to the thread, and return `{ turnId, status: 'completed' }`

#### Scenario: Subsequent turn with history
- **WHEN** the user calls `turn.start` on a thread with N prior turns
- **THEN** the runtime MUST send all prior items plus the new user message to the LLM

#### Scenario: Busy rejection
- **WHEN** a thread has an in-flight turn and the user calls `turn.start` on it
- **THEN** the runtime MUST return `{ ok: false, code: 'RUNTIME_TURN_BUSY' }` without starting a new turn

### Requirement: Worker isolation for LLM calls

The runtime MUST run LLM inference in a Node `worker_thread` (`src/main/infrastructure/llm-worker/worker.ts`). The main process MUST NOT import the LLM SDK directly. The worker MUST communicate with the main process via `parentPort.postMessage` using a zod-validated schema.

#### Scenario: Worker crash recovery
- **WHEN** the worker terminates unexpectedly with a non-zero exit code
- **THEN** the runtime MUST emit a `runtime_error` event with `{ kind: 'worker_crashed', code }` and MUST restart the worker for the next request

#### Scenario: Cancellation propagates
- **WHEN** the user calls `turn.interrupt` on an in-flight turn
- **THEN** the runtime MUST post a `{ type: 'cancel' }` message to the worker and the worker MUST abort the in-flight HTTP request

### Requirement: Tool execution with approval gate

When the LLM requests a tool call, the runtime MUST check the tool's policy. If policy is `on-request` or `untrusted`, the runtime MUST emit an `approval_requested` event and pause the loop until the user responds. If policy is `auto`, the runtime MUST execute the tool and emit a `tool_executed` event.

#### Scenario: Auto-allowed tool
- **WHEN** the LLM requests a tool with `policy: 'auto'`
- **THEN** the runtime MUST execute the tool, append a `tool` item with the result, and continue the loop

#### Scenario: Approval required
- **WHEN** the LLM requests a tool with `policy: 'on-request'`
- **THEN** the runtime MUST emit `approval_requested` and MUST NOT execute the tool until the user posts `approval.respond` with `decision: 'allow'`

### Requirement: Event stream over IPC

The runtime MUST emit typed `RuntimeEvent`s (`turn_started`, `turn_completed`, `turn_failed`, `item_appended`, `approval_requested`, `runtime_error`) to the main-process event bus. The IPC layer MUST forward each event to subscribed renderers via `webContents.send`.

#### Scenario: Renderer subscribes
- **WHEN** the renderer calls `sse.subscribe(threadId)`
- **THEN** the IPC layer MUST register the renderer as a subscriber and forward all subsequent events for that threadId

#### Scenario: Unsubscribed renderer gets nothing
- **WHEN** a renderer has not called `sse.subscribe(threadId)` and the runtime emits an event for `threadId`
- **THEN** the IPC layer MUST NOT send that event to that renderer

### Requirement: Backward-compatible single-run adapter

The runtime MUST expose a `runOnce(request: AgentRunRequest): Promise<AgentRunResponse>` function that internally creates a thread, starts a turn, subscribes to events, and resolves when the turn completes. The function MUST return a result compatible with the existing `AgentRunResponse` shape.

#### Scenario: Legacy call works
- **WHEN** external code calls `runOnce({ goal, model, apiKey, ... })`
- **THEN** the system MUST return an `AgentRunResponse` with the same `status`, `output`, and `trace` fields as the original single-run implementation

## ADDED Requirements

### Requirement: Interrupt stops the turn cleanly
The runtime MUST support mid-turn cancellation. When `turn.interrupt` is called, the runtime MUST mark the in-flight turn as `interrupted`, append a `system` item with text `Interrupted by user`, and emit a `turn_completed` event with `status: 'interrupted'`.

#### Scenario: Interrupt during streaming
- **WHEN** the user clicks interrupt while the assistant message is streaming
- **THEN** the streaming MUST stop within 500ms and the partial assistant text MUST be persisted as a `truncated` item

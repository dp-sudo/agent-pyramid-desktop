## ADDED Requirements

### Requirement: Thread record storage

The persistence layer MUST store each thread as a directory under `{userData}/threads/{threadId}/` containing three files: `thread.json`, `messages.jsonl`, and `events.jsonl`. The `thread.json` MUST be written atomically (write to `.tmp`, then `rename`) to prevent corruption.

#### Scenario: Create thread
- **WHEN** the runtime calls `threads.create({ title, workspace, mode })`
- **THEN** the persistence layer MUST create `{userData}/threads/{newId}/thread.json` with the thread record, initialize empty `messages.jsonl` and `events.jsonl` files, and update `{userData}/threads/index.json` atomically

#### Scenario: Concurrent writes safe
- **WHEN** two `threads.update` calls race for the same thread
- **THEN** the persistence layer MUST serialize them via a per-thread mutex and the second write MUST observe the first write's content

### Requirement: Append-only message and event streams

`messages.jsonl` and `events.jsonl` MUST be append-only. Each line MUST be a valid JSON object conforming to the `Item` or `RuntimeEvent` schema. The persistence layer MUST write lines in order and MUST flush to disk before returning from the write call.

#### Scenario: Append order preserved
- **WHEN** the runtime appends 3 items in order A, B, C
- **THEN** the file content MUST be three lines in that exact order, line-broken between them

#### Scenario: Malformed lines are skipped on replay
- **WHEN** `events.replay(threadId)` reads `events.jsonl` and encounters a non-JSON line
- **THEN** the replay MUST skip that line, log a warning, and continue with the remaining lines

### Requirement: Index file for fast listing

`{userData}/threads/index.json` MUST contain a list of `ThreadSummary { id, title, updatedAt, relation, workspace }` records. The index MUST be written atomically on every `threads.create` / `threads.update` / `threads.delete`.

#### Scenario: List without scanning subdirectories
- **WHEN** the renderer calls `threads.list()`
- **THEN** the persistence layer MUST return the list directly from `index.json` without scanning subdirectories

#### Scenario: Delete removes from index
- **WHEN** `threads.delete(threadId)` succeeds
- **THEN** the persistence layer MUST remove the thread's entry from `index.json` and remove the thread's directory

### Requirement: Thread relation metadata

`ThreadRecord` MUST include a `relation` field with one of `primary`, `fork`, `side`. When `relation` is `fork` or `side`, the record MUST also include `parentThreadId` and `forkedAt` fields.

#### Scenario: Default is primary
- **WHEN** `threads.create` is called without specifying `relation`
- **THEN** the persisted record MUST have `relation: 'primary'`

#### Scenario: Fork sets lineage
- **WHEN** `threads.fork(parentId, options)` is called
- **THEN** the new thread MUST have `relation: 'fork'`, `parentThreadId: parentId`, and `forkedAt: <current ISO timestamp>`

### Requirement: Search and filter

The persistence layer MUST support filtering the thread list by `relation` (default: exclude `side`) and by free-text search on `title`.

#### Scenario: Side threads hidden by default
- **WHEN** `threads.list()` is called without options
- **THEN** the returned list MUST NOT include threads with `relation: 'side'`

#### Scenario: Include side
- **WHEN** `threads.list({ include: ['side'] })` is called
- **THEN** the returned list MUST include threads with `relation: 'side'`

#### Scenario: Title search
- **WHEN** `threads.list({ search: 'fix' })` is called
- **THEN** the returned list MUST include only threads whose `title` contains the substring `fix` (case-insensitive)

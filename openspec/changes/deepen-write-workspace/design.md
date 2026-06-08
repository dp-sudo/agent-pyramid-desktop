## Context

The previous `isolate-write-and-code-workbenches` change made Code and Write thread/tool boundaries explicit. That is necessary but not sufficient: Write still needs its own editor state and assistant context model before richer features such as CodeMirror, inline edit diff review, RAG memory, and file lifecycle controls can be implemented safely.

## Goals / Non-Goals

**Goals:**

- Establish a single `WriteWorkspaceState` authority for the Write route.
- Send Write assistant turns through `mode: "write"` threads with structured, scoped context.
- Keep document content, assistant draft, and global Code composer state separate.
- Track enough editing context to support future inline edit scope checks and diff confirmation.

**Non-Goals:**

- Do not add model-executed Write tools yet.
- Do not implement RAG indexing, inline diff approval UI, export, image preview, or file create/rename/delete in this step.

## Decisions

### Decision 1: Renderer Write state is the immediate authority

`WorkbenchContext` owns `WriteWorkspaceState` with fields for workspace, active file, content, dirty/saving/error, selection, preview mode, assistant panel state, recent edits, and inline completion state. This keeps editor state out of the global composer and gives later editor kernels a stable state contract.

### Decision 2: Write assistant context is injected as structured text

The Write assistant send path uses the existing `turns.start` contract and `displayText` field. `text` contains a structured `write:assistant-context` payload with active file, dirty flag, selection, cursor neighborhood, and recent edits; `displayText` contains only the user's explicit request. This avoids new IPC while preserving a clear boundary.

### Decision 3: Assistant context is scoped and clipped

The first context version sends selected text, a limited cursor window, and recent edit summaries instead of the full document. This is safer for long documents and creates a natural insertion point for observable RAG memory later.

### Decision 4: Future write AI actions need dedicated contracts

Inline completion, inline edit, assistant context retrieval, diff confirmation, and memory retrieval should become Write-specific contracts. They must not call Code tools such as `edit_file`, `apply_patch`, or `run_command`.

### Decision 5: Code and Write share the composer input surface

The Write assistant reuses the same `ComposerInputSurface` used by the Code composer for draft entry, Enter-to-send, pending state, send button, and interrupt handling. Code and Write still provide separate state adapters: Code binds the surface to global `composer`, attachments, model picker, plan, and goal controls; Write binds it to `writeWorkspace.assistantDraft` and does not expose Code-only attachment/plan/goal controls.

## Risks / Trade-offs

- [Risk] CodeMirror increases renderer bundle size. → Mitigation: it replaces the textarea only in the Write route and uses `WriteWorkspaceState` as the stable adapter boundary.
- [Risk] Structured context is passed as prompt text rather than a typed main-process request. → Mitigation: it uses existing `displayText` to keep the UI readable and is isolated to Write threads.
- [Risk] Recent edit summaries are lightweight. → Mitigation: they are a safe first contract and can later be backed by scoped diff records.

## Migration Plan

1. Add `WriteWorkspaceState` to the renderer context.
2. Migrate Write editor state and completion state to that model.
3. Add a Write assistant panel and context payload builder.
4. Add tests for context payloads, selection-aware completion, and state isolation.
5. Replace the textarea with CodeMirror while preserving `WriteWorkspaceState`.
6. Reuse the shared composer input surface for Write assistant prompts.
7. Update docs and run typecheck/test/build.

## 1. State And Assistant Context Foundation

- [x] 1.1 Add `WriteWorkspaceState` and reducer actions for file state, selection, assistant draft, recent edits, and completion state.
- [x] 1.2 Migrate Write editor state from component-local scattered state to `WriteWorkspaceState`.
- [x] 1.3 Add a Write assistant panel that sends explicit prompts through `mode: "write"` threads.
- [x] 1.4 Build a structured `write:assistant-context` payload from active file, selection, cursor snippets, and recent edits.
- [x] 1.5 Keep local completion editor-scoped and insert accepted completion at the current cursor.

## 2. Documentation And Verification

- [x] 2.1 Update runtime/UI/development docs for the new Write state and assistant context flow.
- [x] 2.2 Run `npm run typecheck`.
- [x] 2.3 Run `npm run test`.
- [x] 2.4 Run `npm run build`.

## 3. Future Write Mechanisms

- [x] 3.1 Replace textarea with a dedicated editor kernel such as CodeMirror after dependency/design review.
- [x] 3.2 Add Write-specific inline completion and inline edit action contracts.
- [x] 3.3 Add inline diff confirmation and scope verification before applying model edits.
- [x] 3.4 Add observable local writing memory/RAG evidence.
- [x] 3.5 Add file lifecycle operations: tree, create, rename, delete, watch, media preview, export, and large-file protection.

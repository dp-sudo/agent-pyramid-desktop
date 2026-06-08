## Why

The Write route has moved past the first boundary fix, but it is still not a complete writing workbench. The editor needs a single authoritative state model, Write assistant turns must carry scoped writing context, and future inline edit/RAG/file lifecycle work needs contracts that do not reuse Code tools.

The immediate product problem is that a writing prompt should be about the current document state, selection, cursor neighborhood, and recent edits, while the document itself remains an editor document rather than a chat composer draft. This change turns Write into its own workspace flow and establishes the foundations for richer editing mechanisms.

## What Changes

- Define a renderer-owned `WriteWorkspaceState` independent from the global composer.
- Add a Write assistant send path that targets `mode: "write"` threads and injects structured context through the existing turn contract.
- Track active file, dirty/saving/error state, selection, preview mode, assistant panel state, recent edits, and inline completion state in one model.
- Keep local Markdown completion isolated from assistant prompts and insert completions at the current cursor.
- Document the next Write-specific boundaries for inline completion, inline edit/diff confirmation, observable writing memory, and file lifecycle services.

## Capabilities

### New Capabilities
- `write-workspace`: Defines the Write workbench state, assistant context, and future Write action boundaries.

## Impact

- Affects renderer state in `src/renderer/src/ui/store/WorkbenchContext.tsx`.
- Affects Write UI behavior in `src/renderer/src/ui/components/write/WriteWorkspaceView.tsx`.
- Affects Write assistant turn creation in `src/renderer/src/ui/Workbench.tsx`.
- Updates renderer tests and UI/runtime documentation.
- Does not import, link, copy, or build external DeepSeek GUI reference source.

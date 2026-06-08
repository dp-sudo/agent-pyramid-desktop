## Why

The current Write route is only a Markdown editor shell and leaks into the Code workbench through shared composer state and code-thread creation. This change establishes a hard boundary so Code tools cannot act in Write flows and Write-specific behavior cannot pollute Code agent logic.

## What Changes

- Separate Code and Write workbench responsibilities at the thread, composer, and tool-exposure layers.
- Ensure Write route assistant turns create or select `mode: "write"` threads instead of falling back to Code threads.
- Stop mirroring full Write document content into the global Code composer draft.
- Gate coding and command tools so they are exposed only to Code threads.
- Keep Write file services and future Write AI actions separate from coding tools such as `edit_file`, `write_file`, `apply_patch`, `run_command`, and workspace diagnostics.
- Add tests and documentation that make Code/Write boundary regressions visible.

## Capabilities

### New Capabilities
- `write-code-boundary`: Defines the required isolation between Code workbench behavior, Write workbench behavior, and their available tools.

### Modified Capabilities

## Impact

- Affects renderer routing and send logic in `src/renderer/src/ui/Workbench.tsx`.
- Affects Write editor state handling in `src/renderer/src/ui/components/write/WriteWorkspaceView.tsx`.
- Affects runtime tool exposure and execution policy in `src/main/application/agent-runtime.ts`.
- May affect tests under `tests/main/application/agent-runtime.test.ts`, `tests/renderer/write-workspace-view.test.ts`, and related Workbench tests.
- Updates project documentation for runtime flow, IPC/UI layout, and agent development boundaries.

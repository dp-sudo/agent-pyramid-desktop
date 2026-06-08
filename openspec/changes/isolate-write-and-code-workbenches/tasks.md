## 1. Boundary Tests

- [x] 1.1 Add runtime tests proving Write threads exclude and reject Code-only tools while Code threads keep them.
- [x] 1.2 Add renderer tests proving route-aware thread creation prefers Write threads on the Write route.
- [x] 1.3 Add Write editor tests proving document edits and completion acceptance do not overwrite global composer text.

## 2. Runtime Isolation

- [x] 2.1 Centralize Code-only tool classification in `AgentRuntime`.
- [x] 2.2 Filter tool definitions by `ThreadRecord.mode`.
- [x] 2.3 Reject forced Code-only tool calls in Write threads before approval or execution.

## 3. Renderer Isolation

- [x] 3.1 Make the Workbench send path create route-matching thread modes.
- [x] 3.2 Make workspace selection prefer route-matching threads.
- [x] 3.3 Remove Write document-to-composer mirroring from `WriteWorkspaceView`.

## 4. Documentation And Verification

- [x] 4.1 Update runtime/UI/development docs to describe Code/Write thread and tool boundaries.
- [x] 4.2 Run `npm run typecheck`.
- [x] 4.3 Run `npm run test`.
- [x] 4.4 Run `npm run build`.

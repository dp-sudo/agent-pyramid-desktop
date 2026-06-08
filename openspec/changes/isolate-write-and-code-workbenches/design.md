## Context

The desktop app currently has a mature Code agent runtime with workspace, coding, command, plan, and goal tools. The Write route is much thinner: it lists Markdown files, opens one in a textarea, autosaves it, and requests a local Markdown pattern completion. Two boundary leaks are visible in the current implementation:

- Write document content is mirrored into the global composer draft, which is also used by the Code workbench.
- Sending a message without an active thread creates a `mode: "code"` thread even when the UI route is Write.

The runtime already stores `ThreadRecord.mode` as `"code" | "write"`, so the boundary can be enforced without adding a new data model. The change must stay inside this repository and must not import, link, copy, or build external DeepSeek GUI reference code.

## Goals / Non-Goals

**Goals:**

- Make Code and Write thread creation deterministic from the active workbench route.
- Prevent Code-only tools from being exposed to or executed in Write threads.
- Keep Write document editing state separate from Code composer state.
- Provide a small Write assistant context path that can use a Write thread without granting coding tools.
- Add regression tests that fail when Code/Write tool boundaries leak.

**Non-Goals:**

- Do not implement the full DeepSeek-style CodeMirror editor, RAG, export, file tree, or inline edit system in this change.
- Do not add new third-party dependencies.
- Do not alter coding tool internals except where required to enforce mode boundaries.
- Do not change persisted thread format beyond using the existing `mode` field correctly.

## Decisions

### Decision 1: Enforce tool isolation in `AgentRuntime`

`AgentRuntime.listToolDefinitionsForTurn()` and `AgentRuntime.isToolAvailableForTurn()` are the authoritative runtime gates. The implementation will apply a catalog-level tool access policy before approval/sandbox policy. The default policy filters tools by `thread.mode`:

- Code threads can see and execute workspace read tools, coding write tools, command/diagnostic tools, plan tools in plan mode, and goal tools when goal mode is active.
- Write threads cannot see or execute coding write tools or command/diagnostic tools.
- Write threads can continue to use goal tools when goal mode is active and can use plan tools only if the same existing plan-mode contract allows it.
- Callers can inject a per-mode tool access policy to explicitly allow or deny individual tool names. This keeps the default Code/Write separation while allowing future settings or product modes to opt a specific tool in or out without changing persisted thread data.

Alternative considered: split the registry into separate Code and Write registries. That would make composition explicit, but it requires broader constructor and test changes. Runtime filtering is smaller and uses the existing authoritative gate.

### Decision 2: Route-based thread creation in the renderer

The Workbench send path will create `mode: "write"` threads when `state.route === "write"` and `mode: "code"` threads otherwise. When picking a workspace from Write, the UI should prefer the latest active Write thread for that workspace instead of a Code thread.

Alternative considered: create a separate Write assistant panel and send path immediately. That is the right long-term shape, but a route-aware send path fixes the current boundary leak with less blast radius.

### Decision 3: Stop mirroring document content into composer draft

The Write editor component will keep document content in local Write state and will not call `actions.setComposerText()` on every document edit or completion accept. User prompts for a Write assistant should be explicit and separate from document text.

Alternative considered: keep mirroring but tag composer text as document context. This preserves the current behavior, but it keeps Code and Write concerns mixed and risks sending full drafts as user prompts.

### Decision 4: Document Write services as file services, not agent tools

Existing `window.agentApi.write.*` IPC remains renderer-invoked file/editor service surface. It is not made available as model tools in this change. Future Write AI actions should use dedicated Write IPC/contracts or a dedicated Write tool set, not the Code coding tools.

## Risks / Trade-offs

- [Risk] Existing users may expect switching from Write to Code to preload the composer with the full document. → Mitigation: remove this coupling intentionally and document the boundary.
- [Risk] Write assistant remains less capable after Code tools are blocked. → Mitigation: this is required for safety; future Write tools must be designed with write-specific contracts.
- [Risk] Runtime filtering by tool names can drift when new tools are added. → Mitigation: centralize mode classification in helper functions and cover it with tests.
- [Risk] Plan/goal tools may have ambiguous Write semantics. → Mitigation: preserve existing plan/goal mode contracts, but block coding/command tools unambiguously.

## Migration Plan

1. Add tests for Code/Write thread creation and runtime tool exposure.
2. Implement runtime mode filtering for Code-only tools.
3. Update Write route behavior so editor changes no longer mutate composer text.
4. Update docs to describe the Code/Write boundary.
5. Run `npm run typecheck`, `npm run test`, and `npm run build`.

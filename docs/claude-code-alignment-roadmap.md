# Claude Code Alignment Roadmap

This document is the working roadmap for aligning `agent-pyramid-desktop` with
Claude Code-style agent capabilities. It turns the broad goal into bounded,
verifiable implementation slices.

## Boundary

- `docs/external-references/` is read-only design input only.
- Do not import, link, copy, build, test, package, or run files from
  `docs/external-references/`.
- Do not add `docs/external-references/` to `package.json`, `tsconfig*.json`,
  Vite, Electron, Vitest, or runtime configuration.
- Implementation must stay in `src/`, tests in `tests/`, and current project
  documentation in `docs/`.
- Each code slice must output a Pre-Flight Manifest, touch one responsibility
  boundary, and pass `npm run typecheck`, `npm run test`, and `npm run build`.

## Evidence Inputs

Project evidence:

- Tool runtime: `src/main/application/agent-runtime.ts`,
  `src/main/application/tool-call-executor.ts`,
  `src/main/application/tool-catalog.ts`,
  `src/main/application/tool-policy.ts`.
- Tool contracts: `src/main/domain/agent/types.ts`,
  `src/shared/agent-contracts.ts`.
- Command tools: `src/main/application/tools/command-tools.ts`,
  `src/main/application/tools/command-process-runner.ts`,
  `src/main/application/tools/command-environment.ts`,
  `src/main/application/tools/command-progress-reporter.ts`,
  `src/main/application/tools/command-session-capture.ts`.
- Coding tools and workspace boundary:
  `src/main/application/tools/coding-tools.ts`,
  `src/main/application/tools/workspace-policy.ts`,
  `src/main/persistence/checkpoint-store.ts`.
- Current behavior docs: `docs/project-map.md`, `docs/runtime-flow.md`,
  `docs/data-model.md`, `docs/ipc-contracts.md`.

External design signals, read-only:

- Claude Code-style skill and agent examples under
  `docs/external-references/claude code/.claude/`.
- Reasonix docs describe per-run tool registries, MCP
  `mcp__<server>__<tool>` naming, per-call permission gates, and sandbox as a
  separate enforcement layer.
- Kun docs emphasize stable tool catalogs, tool-call/tool-result history
  hygiene, bounded tool output, read-only concurrency, and repeat-call
  suppression.

## Transferable Patterns

- Keep tool catalog, approval policy, sandbox enforcement, and tool execution as
  separate boundaries.
- Treat tool schema and tool metadata as model-visible contracts, then validate
  model-provided arguments again immediately before previews and execution.
- Execute only read-only tool batches in parallel; preserve model call order when
  writing tool results back into the next request.
- Feed structured tool failures back to the model instead of converting expected
  tool errors into fatal turn failures.
- Treat terminal commands as write-capable by default; approval shortcuts must be
  narrower than sandbox enforcement.
- Keep MCP tools opaque unless the server explicitly marks them read-only.
- Preserve coding safety with workspace realpath checks, no-follow final writes,
  checkpoint snapshots, and replay/rewind evidence.

## Current Baseline

### Agent Tool Calling

Implemented evidence:

- `ToolCatalogService` filters model-visible tools by mode and preferences, sorts
  definitions, and records `{ fingerprint, toolCount, toolNames }`.
- `ToolCallExecutor` owns tool item lifecycle, schema validation, approval,
  repeat read-only suppression, live progress, and interruption cleanup.
- `ToolPolicyService` combines read-only metadata, plan/goal gates, sandbox,
  approval policy, and `permissionRules`.
- Command permission candidates for shell-like tools are structured by tool,
  normalized `command="..."`, cwd, and shell selector context. Command `:*`
  permission scopes are conservative: the approved prefix can carry ordinary
  arguments, but appended shell control, redirection, substitution, or
  newline-separated commands fall back to approval. Older bare command patterns
  still match the parsed command field for compatibility.
- Multi-target write permission candidates, including `apply_patch`, require
  allow coverage for every target path before they can skip approval; ask or deny
  matches on any target still take precedence.
- Approval responses support scoped backend decisions: `once`, in-memory
  `session`, and persisted exact `permissionRules` grants. Hard read-only
  sandbox and `approvalPolicy: never` still run before these grants.
- Request-boundary tests prove forked-thread first requests and resumed
  compacted requests keep tool-call/tool-result history protocol-valid.
- MCP tools are dynamically registered as `mcp__<server>__<tool>`.
- MCP servers with large tool catalogs switch to progressive discovery facade
  tools: search, describe, read-only call and write-capable call. Small catalogs
  keep direct registration, and the write-capable facade maps approval and
  permission rules to the selected target MCP tool rather than the facade name.
- Skills can inject dynamic context and `runAs: subagent` can run with a
  restricted read-only tool set.

Open gaps:

- None currently assigned in this section.

### Agent Terminal Commands

Implemented evidence:

- Foreground shell, explicit shell, Git, package/task, diagnostics, and command
  session tools are split into separate tool definitions.
- Command cwd uses the workspace policy; child environments strip
  credential-like variables while preserving shell basics.
- Shell command permission scopes reject operator-bearing prefix continuations
  instead of widening an approved prefix to unrelated follow-up commands, and
  structured rules can bind that prefix to a specific tool/cwd/shell context.
- Command session stdin write permission candidates include the exact input and
  newline mode, so scoped approvals for one session write do not authorize
  different future input.
- Foreground commands and sessions support timeout, abort, process-tree cleanup,
  UTF-8-safe output capture, and live `tool_progress`.
- Command sandboxing has a dedicated spawn-time profile in
  `command-sandbox.ts`: foreground commands and long-running sessions share
  workspace-realpath cwd enforcement, credential-filtered environments,
  `shell: false`, non-inherited stdio, hidden windows, and platform-specific
  process-tree cleanup. `detect_shell_environment` reports this profile and
  explicitly records that Node/Electron has no built-in cross-platform OS jail.
- Git tool pathspec inputs stay workspace-relative at the public tool boundary
  and are converted to Git's cwd-relative form after validation, so subdirectory
  command cwd does not silently narrow or miss requested files.
- Long-running sessions support start/list/read/write/stop with same
  thread/workspace visibility checks.
- App shutdown invokes a main-process command-session cleanup hook that uses the
  shared process-tree kill path and returns bounded diagnostic snapshots before
  clearing in-memory ownership.
- Approval UI offers scoped decisions for allow once, allow for session, and
  persist exact allow rule, and the renderer sends the selected scope through
  the existing approval IPC contract.

Open gaps:

- None currently assigned in this section.

### Agent Coding Development

Implemented evidence:

- Read/search, edit, multi-edit, write, delete, apply-patch, rollback, and
  diagnostics/symbol tools are split by responsibility.
- Coding writes enforce workspace realpath boundaries, skipped directories,
  strict UTF-8, fresh read-state, symlink checks, diff previews, file history,
  checkpoint snapshots, and rollback-on-failed-post-write metadata.
- `apply_patch` validates restricted unified diff hunks before writing,
  restores already-written files if a later file fails, and discards failed
  patch checkpoint snapshots after rollback.
- Checkpoint rewind revalidates workspace and symlink boundaries before restore.
- `rollback_file` uses current-process file history first and can fall back to
  persisted same-thread/workspace checkpoint snapshots after restart when the
  live file still matches the recorded post-write hash.
- Code vs Write mode tool availability is enforced through catalog policy and
  preferences.
- Completed coding/development turns append deterministic completion evidence as
  a user-visible `SystemItem`, derived from the final `ToolItem.result` values
  and checkpoint metadata for the same turn. It summarizes files changed,
  commands run, checkpoint snapshot availability, and remaining risk without
  inventing verification that was not run.
- `search_symbols` adds bounded project-wide TypeScript/JavaScript symbol
  search/map output using the same short-lived Language Service boundary as
  `list_symbols`, with workspace skip-policy filtering and no persistent LSP
  process or long-lived index.
- `create_edit_plan` adds a read-only, Code-only visible coordination surface
  for multi-file changes that will be applied through separate sequential
  coding tool calls. It validates workspace-relative planned files and appends
  the same `PlanItem` timeline surface used by plan mode without claiming an
  all-or-nothing transaction.

Open gaps:

- None currently assigned in this section.

## Roadmap Slices

### Phase 0: Baseline And Guardrails

- ROAD-0.1: Document this roadmap and keep it linked from
  `docs/agent-development.md`.
- ROAD-0.2: Keep `tool_progress` renderer merging keyed by
  `threadId` / `turnId` / `toolCallId`, with regression coverage.

Acceptance:

- The roadmap exists and lists current evidence, gaps, and slice ids.
- Runtime docs describe live progress identity the same way the renderer
  implements it.
- Full typecheck/test/build pass with any code changes in the worktree.

### Phase 1: Tool Gate Hardening

- TOOL-1: Completed. Command-prefix permission rules no longer cover commands
  that append shell operators or unrelated second commands.
- TOOL-2: Completed. Approval responses now carry optional scope, session grants
  and persisted exact permission rules are generated from pending tool
  subjects, and tests cover hard sandbox/`never` precedence.
- TOOL-3: Completed. Large MCP catalogs use progressive search/describe/call
  facade tools while small catalogs keep direct `mcp__<server>__<tool>`
  registration; approval rules for the write-capable facade resolve to the
  selected target tool.
- TOOL-4: Completed. Request-boundary tests assert forked-thread first requests
  do not replay parent tool history and resumed compacted requests contain no
  orphan or incomplete tool-call/tool-result pairs.

Acceptance:

- Forced model calls cannot bypass catalog availability, schema validation,
  sandbox, or permission rules.
- Read-only parallelism never includes write-capable, command, or subagent model
  loops.
- Tool failure results remain structured and visible in `ToolItem.result`.

### Phase 2: Terminal Command Robustness

- TERM-1: Completed. Shell-like command tools and command sessions share the
  same safer command-prefix permission semantics.
- TERM-2: Completed. Command sessions are owned by the main-process singleton,
  app shutdown terminates active session process trees through a narrow cleanup
  hook, and wrapper-boundary tests cover returned diagnostics and owner clearing.
- TERM-3: Completed. OS-level jail options were evaluated at the runtime
  boundary: Node/Electron does not provide a built-in cross-platform jail, so
  command execution now has a separate spawn-time sandbox profile and diagnostic
  instead of conflating sandbox policy with approval. The profile is shared by
  foreground commands and sessions, and read-only sandbox still denies command
  tools before spawn.
- TERM-4: Completed. Approval cards and pending approval panels expose scoped
  choices and show resolved rule effects from approval item scope.

Acceptance:

- Commands have bounded cwd, env, output, timeout, cancellation, and cleanup.
- Approval shortcuts cannot widen command authority beyond the approved subject.
- Live stdout/stderr remains visible while final command result stays durable in
  `ToolItem.result`.

### Phase 3: Coding Development Depth

- CODE-1: Completed. Single-file rollback now restores from current-process file
  history first, then from persisted checkpoint file snapshots when the live
  file still matches the checkpoint `afterSha256`; tests cover restart-safe
  lookup, rollback, and stale-content refusal.
- CODE-2: Completed. Project-level symbol search is available through
  `search_symbols`, starting with TypeScript/JavaScript project files and
  bounded on-demand Language Service extraction instead of a long-lived server.
- CODE-3: Completed. `create_edit_plan` exposes a visible, read-only multi-file
  coordination plan before separate edit/write/delete calls, while `apply_patch`
  remains the all-or-nothing tool for a single coordinated patch.
- CODE-4: Completed. Runtime now appends per-turn coding completion evidence
  that summarizes touched files, command/test results, checkpoint availability,
  and remaining risk from durable tool/checkpoint records.

Acceptance:

- Writes never escape the workspace, including through symlinks or stale
  dry-runs.
- Multi-file failures are all-or-nothing where the tool contract claims they
  are.
- Rewind/rollback behavior is explicit, tested, and documented.

## Completion Audit

The goal is not complete until each of the following has direct evidence:

- Tool calling: schema validation, metadata, approval, sandbox, MCP, skills,
  budget, interruption, structured failures, read-only parallelism, and history
  hygiene are implemented and tested.
- Terminal commands: foreground/background sessions, progress streaming, cwd/env
  isolation, timeout/cancel/process cleanup, command/Git/package split, sandbox,
  permission rules, and approval UX are implemented and tested.
- Coding development: read/write/edit/patch/delete/rollback, multi-file
  coordination, project map/symbols, workspace boundary, checkpoints/rewind,
  Code vs Write permissions, and completion evidence are implemented and tested.
- `npm run typecheck`, `npm run test`, and `npm run build` pass after the final
  slice.

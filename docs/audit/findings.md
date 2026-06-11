# Project Audit Findings

Status: in progress. This file is the structured audit ledger for the ongoing
repository health check. It records evidence-backed findings discovered so far;
it does not yet claim that every file in `src/main/`, `src/preload/`,
`src/renderer/src/`, and `src/shared/` has been exhaustively audited.

Verification evidence already collected:

- `rg` found no literal silent `catch {}` in active `src/` and `tests/` paths.
- i18n key parity check found `en` and `zh-CN` both have 460 flattened keys and
  no missing keys on either side.
- Current IPC error-code search found no production `err("...")` call sites
  after the `IPC_ERROR_CODES` consolidation.
- `npm run test:coverage` now produces a V8 report; the latest run measured all
  files at 65.28% statements / 63.4% branches / 66.85% lines and
  `src/main/application/agent-runtime.ts` at 86.26% statements / 77.21%
  branches / 87.46% lines.

## Open Findings

| ID | Module | Category | Severity | Location | Finding | Next action |
| --- | --- | --- | --- | --- | --- | --- |
| MAIN-COVERAGE-001 | main | defect | major | `src/main/application/agent-runtime.ts:1` | The source-wide V8 coverage run measures `AgentRuntime` below the requested 100% main-path coverage target: 86.26% statements, 77.21% branches, 93.65% functions, and 87.46% lines after adding focused historical tool-call argument hygiene coverage. | Use `coverage/coverage-summary.json` and the HTML report to target uncovered AgentRuntime branches and add focused regression tests before claiming full main-path coverage. |

## Resolved During Current Audit

| ID | Module | Category | Severity | Location | Resolution |
| --- | --- | --- | --- | --- | --- |
| SHARED-CONFLICT-001 | shared | conflict/compat | major | `src/shared/ipc-errors.ts:1` | IPC error-code wire values now have one shared authority via `IPC_ERROR_CODES` and `IpcErrorCode`; main IPC handlers and renderer IPC fallbacks reference the shared object instead of direct `err("...")` literals. |
| MAIN-CONFLICT-001 | main | conflict/compat | major | `src/main/infrastructure/minimax/minimax-gateway.ts:648` | Provider-specific API key fallback now lives in `MiniMaxGateway.resolveRequestApiKey()`. `AgentRuntime` passes only the configured profile key, so DeepSeek/MiniMax/custom environment fallback is handled at the provider gateway boundary with regression coverage in `tests/main/infrastructure/minimax-gateway.test.ts`. |
| MAIN-CONFLICT-002 | main | conflict/compat | major | `src/main/application/constants.ts:5` | AgentRuntime tool autonomy rounds, max round clamp, warning threshold, continuation message, context budget ratio, tool result/argument limits, compaction thresholds, token estimate ratio, and interrupt settle timeout now live in `src/main/application/constants.ts`, preserving existing behavior with one main-process authority. |
| MAIN-CONFLICT-003 | main | conflict/compat | major | `src/main/application/constants.ts:35` | `MAX_SEARCH_FILE_BYTES` is now exported from one main application constants file and imported by both `workspace-tools.ts` and `command-tools.ts`, preserving the existing `1_000_000` byte policy with one authority. |
| MAIN-CONFLICT-004 | main | conflict/compat | minor | `src/main/application/constants.ts:37` | Usage daily default window, max window, and cache TTL are now exported from `src/main/application/constants.ts` and imported by `usage-handlers.ts`, preserving the existing `30` day, `180` day, and `10_000` ms policy values with one main-process authority. |
| MAIN-CONFLICT-005 | main | conflict/compat | minor | `src/main/application/constants.ts:41` | Command and command-session policy limits are now exported from `src/main/application/constants.ts` and imported by `command-tools.ts`, preserving existing byte, count, timeout, and buffer values with one main-process authority. |
| RENDERER-REDUNDANT-001 | renderer | redundancy/deprecated | minor | `src/renderer/src/ui/format.ts:1` | Renderer byte-size display now has one shared `formatBytes()` helper imported by composer attachment UI and write file metadata; the existing composer barrel export is preserved and `tests/renderer/format.test.ts` locks the current B/KB/MB formatting policy. |
| RENDERER-CONFLICT-001 | renderer | conflict/compat | minor | `src/renderer/src/ui/components/write/write-constants.ts:1` | Write completion debounce, search debounce, prefix/suffix context limits, completion trigger length, and assistant context limits now have one write-local constants authority with renderer tests asserting default helper boundaries. |
| DOCS-CONFLICT-001 | docs | conflict/compat | minor | `docs/runtime-flow.md:406`, `docs/agent-development.md:1046` | Tool-budget docs now name `src/main/application/constants.ts` and the `AGENT_AUTONOMY_TOOL_ROUNDS` / clamp constants as the code authority while preserving the documented literal values for readers. |
| DOCS-COVERAGE-001 | docs | defect | major | `package.json:13`, `vitest.config.ts:10` | Coverage reporting now has an explicit `npm run test:coverage` script, matching `@vitest/coverage-v8` dev dependency, and source-wide V8 coverage config. The resulting report is generated under the already ignored `coverage/` directory. |
| MAIN-DEFECT-001 | main | defect | critical | `src/main/application/agent-runtime.ts:1000` | Staged runtime fix prevents approved tools from executing after a turn is interrupted while approval resolution is settling; regression coverage is staged in `tests/main/application/agent-runtime.test.ts`. |
| MAIN-DEFECT-002 | main | defect | major | `src/main/persistence/config-file.ts:441` | Staged config normalization deduplicates persisted profile ids before profile mutations run; regression coverage is staged in `tests/main/persistence/model-config-store.test.ts`. |
| MAIN-DEFECT-003 | main | defect | major | `src/main/persistence/index.ts:560` | Staged persistence migration defaults missing legacy thread `relation` fields to `primary`; regression coverage is staged in `tests/main/persistence/jsonl-thread-store.test.ts`. |
| MAIN-DEFECT-004 | main | defect | major | `src/main/persistence/runtime-preferences-schema.ts:191` | Staged runtime-preferences validation rejects empty `toolAvailability` mode objects; regression coverage is staged in `tests/main/persistence/runtime-preferences-store.test.ts`. |
| RENDERER-REDUNDANT-002 | renderer | redundancy/deprecated | minor | `src/renderer/src/ui/components/chat/ChatBlock.tsx:531` | Staged cleanup marks the exhaustive unknown-item parameter as intentionally unused. |

## Module Notes

### main

Current open main findings are mostly hardcoded mechanism ownership issues.
No new critical silent-error finding has been confirmed in the current pass.

### preload

No open preload finding has been confirmed in the current pass. Preload still
needs an explicit pass against `src/preload/index.ts` and `tests/preload/index.test.ts`
before the full audit can be considered complete.

### renderer

Current open renderer findings are low-risk duplication/configuration issues.
i18n key parity is currently clean.

### shared

The IPC error-code authority was added during the audit. Shared constants still
need a broader pass for whether runtime-only limits should live in shared or
main application scope.

### docs

The targeted docs cross-check has started but is not complete. The required full
read of `docs/agent-development.md`, `docs/runtime-flow.md`,
`docs/ipc-contracts.md`, and `docs/data-model.md` remains open for the broader
goal.

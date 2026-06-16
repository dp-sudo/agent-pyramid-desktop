# Security Best Practices Review — `agent-pyramid-desktop`

**Scope:** Comprehensive static review of the codebase under `f:\Agent` against
the project's tech stack (Electron 42 + Vite 7 + React 19 + TypeScript 6, Node
`worker_threads` for LLM isolation, MCP integration).

**References used (security-best-practices skill):**
- `javascript-typescript-react-web-frontend-security.md`
- `javascript-general-web-frontend-security.md`
- General Electron / Node `worker_threads` / `safeStorage` / `shell.openExternal`
  threat modeling (no dedicated reference file in the skill; OWASP Electron
  guidance applied).

**Method:** Read entry points (main process, preload, renderer, IPC, gateway,
tools, MCP, persistence, CSP, navigation handler), plus static pattern searches
for the high-signal DOM XSS sinks, `eval`, command injection, path traversal,
SSRF, and unsafe `localStorage` usage.

---

## Executive summary

The codebase demonstrates a strong security baseline. Critical Electron
hardening is in place: `contextIsolation: true`, `nodeIntegration: false`,
preload uses `contextBridge.exposeInMainWorld` with a narrow typed surface,
all IPC handlers parse and validate payloads, workspace path access is
protected by lexical + realpath + symlink + `O_NOFOLLOW` + post-open lstat
recheck, the LLM HTTP client runs inside `worker_threads`, command execution
uses `spawn` (not `exec`) with `shell: false` and a credential-filtered
environment, API keys are sealed at rest via `safeStorage`, external
navigation is restricted to `http(s)` schemes via `shell.openExternal`, and
the renderer uses `react-markdown` (no `rehype-raw`) with custom URL filters
for `href` / `src` (allowing only `http(s)` + safe `data:` image URLs).

**No Critical findings were identified.** The remaining issues are High /
Medium / Low and are mostly defense-in-depth hardening, scheme allowlist
gaps for user-controlled URLs, and a few minor content-security / supply-chain
items. The most important real concerns are:

1. **H-1** — `base_url` (LLM provider) and **H-2** — MCP `config.url` accept
   arbitrary schemes/hosts without an allowlist, creating an SSRF /
   `file://` exfiltration vector if a profile or MCP server is configured to
   an attacker-influenced endpoint.
2. **H-3** — `API key echo` via HTTP error responses (provider's body
   embedded in thrown error messages, surfaced to renderer + console logs).
3. **H-4** — `style-src 'unsafe-inline'` and `script-src 'self' 'unsafe-inline'`
   in dev CSP weaken the production defense-in-depth.

The remaining items are Medium / Low and are documented below.

---

## Severity: HIGH

### H-1. Unrestricted scheme/host for LLM `base_url` (SSRF / `file://`)

- **Rule ID:** `LLM-BASEURL-001` (custom)
- **Location:**
  - [src/main/ipc/model-config-handlers.ts:188-191](file:///f:/Agent/src/main/ipc/model-config-handlers.ts#L188-L191)
  - [src/main/persistence/config-file.ts:332-334](file:///f:/Agent/src/main/persistence/config-file.ts#L332-L334)
  - [src/main/persistence/config-file.ts:386](file:///f:/Agent/src/main/persistence/config-file.ts#L386)
  - [src/main/infrastructure/minimax/gateway-common.ts:9-35](file:///f:/Agent/src/main/infrastructure/minimax/gateway-common.ts#L9-L35)
  - [src/main/infrastructure/minimax/openai-compatible-adapter.ts:138,174](file:///f:/Agent/src/main/infrastructure/minimax/openai-compatible-adapter.ts#L138)
  - [src/main/infrastructure/minimax/anthropic-compatible-adapter.ts:115,154](file:///f:/Agent/src/main/infrastructure/minimax/anthropic-compatible-adapter.ts#L115)
- **Evidence:** `parseModelConfigUpdateRequest` only requires `base_url` to be
  a non-empty string (`requiredTrimmedString(value.base_url, "base_url")`).
  The value is later concatenated into a URL and passed straight to
  `fetch(url, { method: "POST", ... })`. There is no scheme allowlist, no host
  check, no rejection of `file:`, `data:`, `javascript:`, `blob:`, `ftp:`,
  internal IP / loopback, or `localhost`.
- **Impact:** A profile with a malicious `base_url` (e.g.
  `file:///etc/passwd` or `http://127.0.0.1:5353/`) makes the worker issue
  an authenticated POST (`Authorization: Bearer ${apiKey}`) to that target.
  The `apiKey` is also sent in the body for some provider modes (custom
  OpenAI-compatible may use a different auth header, but `Authorization: Bearer`
  is hard-coded in `postJson`/`postStream` in `gateway-common.ts:74,106`),
  so a single misconfigured profile can leak the API key to a remote host or
  a local network service. The `Authorization` header will travel to
  `file://` (which `fetch` rejects on some platforms, but the error still
  includes the URL and parts of the request) and certainly to arbitrary
  `http(s)` destinations.
- **Fix:** Validate the URL at the IPC boundary and in `normalizeModelConfig`:
  1. Require `new URL(value)` to parse.
  2. Allow only `https:` (and `http://localhost` / `http://127.0.0.1` for
     dev/test only, gated by an env flag).
  3. Reject `file:`, `data:`, `javascript:`, `blob:`, `ftp:`,
     `gopher:`, `view-source:` and any other scheme not in the allowlist.
  4. Optionally reject link-local / loopback ranges for non-dev.
- **Mitigation:** Add an env-flag-gated scheme allowlist in
  `parseModelConfigUpdateRequest` and an additional check inside
  `MiniMaxGateway.stream/complete`.
- **False positive notes:** This is a desktop app; the user is the one
  setting the URL. The risk is when an attacker can influence the URL via
  another channel (a malicious config import, a remote-preferences sync
  feature added later, a corrupted `userData/config` file, or a prompt-
  injection attack that targets an agent that *writes* model config).

### H-2. Unrestricted scheme/host for MCP HTTP `config.url` (SSRF)

- **Rule ID:** `MCP-URL-001` (custom)
- **Location:**
  - [src/main/infrastructure/mcp/http-transport.ts:31-36, 72-77, 103-108](file:///f:/Agent/src/main/infrastructure/mcp/http-transport.ts#L31-L36)
  - [src/main/infrastructure/mcp/host.ts:608-643](file:///f:/Agent/src/main/infrastructure/mcp/host.ts#L608-L643)
- **Evidence:** `HttpMcpTransport.start` stores `config.url` verbatim, and
  `send()` calls `fetch(this.url, ...)` with user-supplied `headers` (which
  may carry `Authorization`). There is no scheme allowlist, no host check,
  and the renderer `SettingsMcpServersPanel` accepts any string the user
  pastes into the URL field.
- **Impact:** Same SSRF class as H-1 but for the MCP server surface. The
  user can also craft MCP tool arguments that cause the configured server
  to issue requests to internal services. Since the user controls the
  config, the realistic threat is (a) accidental exfil of auth headers to
  an internal network and (b) prompt-injection scenarios where the agent
  reads or writes MCP configs.
- **Fix:** Validate `config.url` at config-update time. Enforce `https:`
  (or `http://localhost` for self-hosted MCP on the same host) and reject
  loopback / link-local unless explicitly enabled.
- **Mitigation:** Add a scheme + host allowlist check in
  `mcp-handlers.ts` (or in `McpHost.configure`) before persisting the
  config.
- **False positive notes:** Users may legitimately want to point at
  `http://localhost:*` for local MCP servers. Allow an explicit toggle
  (`allowInsecureHttpLocalhost`) instead of blocking all `http:`.

### H-3. LLM provider response body embedded in thrown errors (API key echo risk)

- **Rule ID:** `LLM-ERRBODY-001` (custom)
- **Location:**
  - [src/main/infrastructure/minimax/gateway-common.ts:78-84, 112-117](file:///f:/Agent/src/main/infrastructure/minimax/gateway-common.ts#L78-L84)
- **Evidence:**
  ```ts
  throw new Error(
    `LLM ${protocol} request failed with HTTP ${response.status}: ${responseText.slice(0, 800)}`,
  );
  ```
- **Impact:** A misbehaving or compromised LLM provider can echo the
  `Authorization` header (or echoed body) in its error response, and the
  first 800 characters are embedded in a thrown `Error`. The error message
  is then:
  1. Surfaced in the renderer via `runtime_error` event (see
     [src/main/application/agent-runtime.ts:173-187](file:///f:/Agent/src/main/application/agent-runtime.ts#L173-L187)),
  2. Logged to the dev/main console via `console.error`, and
  3. Persisted in `events.jsonl` (potentially visible to anyone with
     filesystem access to `userData/threads/<id>/events.jsonl`).
  This widens the API key's exposure surface. It is not exploitable in the
  happy path, but a malicious or compromised provider can weaponize it.
- **Fix:** Strip `Authorization` and any field that looks like a key
  (`sk-…`, `key-…`, JWT) from the captured response body before embedding
  it. Also avoid embedding the *request* URL with the query string (which
  may carry the key for some auth schemes).
- **Mitigation:** Log only status + a short redacted reason; capture the
  full body only behind a debug-flag.
- **False positive notes:** Real LLM providers generally do not echo the
  Authorization header; this is mostly a defense-in-depth item.

### H-4. `style-src 'unsafe-inline'` and dev-mode `script-src 'unsafe-inline'`

- **Rule ID:** `REACT-CSP-001` / `JS-CSP-001`
- **Location:**
  - [src/main/infrastructure/content-security-policy.ts:7-23](file:///f:/Agent/src/main/infrastructure/content-security-policy.ts#L7-L23)
- **Evidence:**
  ```ts
  // dev
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // prod
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  ```
  `connect-src` in dev includes `ws: http://localhost:* http://127.0.0.1:*`
  (Vite HMR) and the production policy does not include `frame-ancestors`
  or `object-src 'none'`.
- **Impact:**
  1. The dev CSP allows inline scripts and `ws://localhost:*` connections
     in the renderer at dev time. A Vite dev server compromise could
     inject inline scripts. Dev-only, but the dev build is the canonical
     build for local data and any sensitive profile the user has.
  2. The production CSP allows `style-src 'unsafe-inline'`. This is
     currently needed by some React + Vite style patterns (style attributes
     set via `element.style.*`, which CSP does not cover, are fine — but
     inline `style` blocks are not). Defense-in-depth loss in case an
     attacker finds a DOM sink that can inject a `<style>` element.
- **Fix:**
  1. Production: keep `style-src 'self'` and use CSS Modules / hashed CSS.
     If `'unsafe-inline'` is required for the React build, justify and
     document it.
  2. Add `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`
     to the production CSP.
  3. Restrict dev `connect-src` to the actual Vite port (not `*`).
  4. The CSP is delivered via `onHeadersReceived` which only applies to
     resources loaded through the session; verify in a packaged build that
     it also covers the main `file://` index (Electron `loadFile` triggers
     a `file:` request, and `onHeadersReceived` may not fire for `file://`).
- **Mitigation:** Verify in a packaged build that the CSP is present on
  the main document response. If not, also emit a `<meta
  http-equiv="Content-Security-Policy">` in [src/renderer/index.html](file:///f:/Agent/src/renderer/index.html)
  for defense-in-depth (and document the meta-CSP limitations: no
  `frame-ancestors`, no `sandbox`).
- **False positive notes:** `style-src 'unsafe-inline'` is widely
  tolerated in modern React apps. Document the trade-off explicitly.

---

## Severity: MEDIUM

### M-1. `signAndEditExecutable: true` enabled by default in `package.json`

- **Rule ID:** `SUPPLY-CODESIGN-001` (custom)
- **Location:** [package.json:30-37](file:///f:/Agent/package.json#L30-L37)
- **Evidence:**
  ```json
  "win": {
    "target": ["portable", "zip"],
    "signAndEditExecutable": true,
    ...
  }
  ```
  The default `package:win` script does not pass `-c.forceCodeSigning=true`;
  only `package:win:signed` does.
- **Impact:** Builds produced by `npm run package:win` are unsigned. Users
  downloading an unsigned build get a SmartScreen warning and have no
  integrity guarantee about the binary they run. While not a code-level
  vulnerability, an attacker who MITMs the download channel can deliver a
  tampered binary that the OS will run with full user privileges.
- **Fix:** Either (a) sign all release builds by default and require a
  positive `AGENT_PYRAMID_SKIP_SIGNING=1` env var to opt out, or (b) keep
  `signAndEditExecutable: true` but make `package:win` require an
  explicit `-c.forceCodeSigning=true` flag.
- **Mitigation:** Document the signing workflow in `docs/` and pin
  `package:win` to call the `:signed` script.

### M-2. MCP server `command` is spawned without an allowlist

- **Rule ID:** `MCP-COMMAND-001` (custom)
- **Location:**
  - [src/main/infrastructure/mcp/stdio-transport.ts:59-69](file:///f:/Agent/src/main/infrastructure/mcp/stdio-transport.ts#L59-L69)
  - [src/renderer/src/ui/components/settings/SettingsMcpServersPanel.tsx:111-149](file:///f:/Agent/src/renderer/src/ui/components/settings/SettingsMcpServersPanel.tsx#L111-L149)
- **Evidence:** `spawn(config.command, config.args, ...)` is called with the
  user-configured command and arguments. The renderer UI accepts any string
  the user types in the `mcpServerCommand` field. There is no command
  allowlist, no SHA/pinning, no signature verification, and `args` are not
  validated (NUL-byte guard exists in facade inputs but not at config-
  write time).
- **Impact:** The threat model is: (a) prompt-injection attack causes the
  agent to add a malicious MCP server, or (b) the user is socially
  engineered into running a malicious config. The blast radius is the
  user's full filesystem and network, because the spawned process runs
  with the user's privileges.
- **Fix:**
  1. Validate `config.command` against an allowlist of well-known MCP
     runtimes (`npx`, `uvx`, `docker`, `node`, `python`, `pwsh`, `bash`).
  2. Reject NUL bytes and absolute paths outside the OS-trusted binaries
     in the `command` field.
  3. Reject `args` that start with `-` for command forms that interpret
     flags (e.g. `npx -y …` is fine; `npx --exec-anything …` should be
     verified).
- **Mitigation:** Show a confirmation dialog before saving a new MCP server
  the first time it connects. Log the resolved `command` + `args` to
  `events.jsonl` so the user can audit later.
- **False positive notes:** Local MCP servers legitimately use absolute
  paths. Make the allowlist per-command-form, not a hard-coded whitelist.

### M-3. `console.error` in main process can leak sensitive data to local logs

- **Rule ID:** `LOG-LEAK-001` (custom)
- **Location:**
  - [src/main/index.ts:54-62, 125-134, 152, 158, 166, 224-239](file:///f:/Agent/src/main/index.ts#L54-L62)
  - [src/main/infrastructure/llm-worker/worker.ts:75-80](file:///f:/Agent/src/main/infrastructure/llm-worker/worker.ts#L75-L80)
  - [src/main/infrastructure/llm-worker/worker-pool.ts:208, 214, 231](file:///f:/Agent/src/main/infrastructure/llm-worker/worker-pool.ts#L208)
  - [src/main/infrastructure/mcp/stdio-transport.ts:178-180](file:///f:/Agent/src/main/infrastructure/mcp/stdio-transport.ts#L178-L180)
- **Evidence:** Worker error messages, MCP stderr, MCP startup errors, and
  uncaught exceptions are written verbatim to `console.error` /
  `console.warn`. These flow to the OS console log (visible to anyone with
  the same user account on Windows / macOS / Linux).
- **Impact:** If any of these messages contain an API key, attachment
  bytes, or attachment metadata, that data ends up in system logs.
  Indirect paths:
  1. Worker error includes `error.message` which can include provider
     response body (see H-3).
  2. MCP startup error includes the MCP server's stderr text (which may
     include the connection URL with embedded auth).
- **Fix:** Route worker / MCP errors through a redacting logger. Strip
  patterns matching `sk-…`, `key-…`, JWTs, and any `config.url` /
  `config.headers` from logged objects before emitting.
- **Mitigation:** Document that local main-process logs may include
  diagnostic data and not secrets.

### M-4. LLM worker pool does not pin the worker to the user-specified
`base_url`; workers are reused across turns and threads

- **Rule ID:** `LLM-WORKER-REUSE-001` (informational)
- **Location:** [src/main/infrastructure/llm-worker/worker-pool.ts:191-202](file:///f:/Agent/src/main/infrastructure/llm-worker/worker-pool.ts#L191-L202)
- **Evidence:** `acquireEntry` routes a `threadId` to a worker based on
  load. Each request sends the full `LlmRequest` (with `baseUrl`,
  `apiKey`, `provider`) over `postMessage`. Workers are long-lived.
- **Impact:** A compromised worker that retains a previous turn's API key
  in memory could be re-used by a different thread. The runtime already
  re-sends the API key per request, so this is mostly fine, but the
  worker keeps the last `MiniMaxGateway` instance and can theoretically
  use cached TLS connections to a different host.
- **Fix:** Consider destroying and re-creating workers when the active
  profile's `baseUrl` or `provider` changes, so TLS / DNS caches do not
  leak across profiles.
- **Mitigation:** Document the worker-affinity behavior.

### M-5. `electron-vite` source map production behavior not specified

- **Rule ID:** `SUPPLY-SOURCEMAP-001` (custom)
- **Location:** [electron.vite.config.ts](file:///f:/Agent/electron.vite.config.ts)
- **Evidence:** No `build.sourcemap` option is set. The default for Vite
  is to disable production source maps for the app, but Rollup outputs
  for main and preload use the `externalizeDepsPlugin` and no explicit
  `sourcemap` flag. Renderer is also unspecified.
- **Impact:** If source maps are emitted to the build, they may end up
  in the `out/` tree and be packaged into the asar bundle. They do not
  directly leak secrets but reveal internal URLs / types / contracts.
- **Fix:** Explicitly set `build.sourcemap = false` (or `"hidden"` for
  upload-only) in the Vite config for main / preload / renderer.
- **Mitigation:** Run `npm run build` and inspect `out/` for `.map` files.

### M-6. `setImmediate(() => { process.on(...) })` for global error handlers

- **Rule ID:** `PROC-ERR-001` (informational)
- **Location:** [src/main/index.ts:223-239](file:///f:/Agent/src/main/index.ts#L223-L239)
- **Evidence:** `setImmediate` is used to defer handler registration until
  the next tick. The handler emits `runtime_error` on the bus with the
  raw error message.
- **Impact:** If the error message contains sensitive data (e.g. a thrown
  `Error` whose `message` includes an API key, which is unlikely but
  possible via the LLM gateway path), it will be broadcast to the
  renderer and persisted.
- **Fix:** Same redacting pattern as M-3. Add a `redactErrorMessage`
  helper.
- **Mitigation:** Document that `runtime_error.message` may include
  provider error bodies.

### M-7. CSP `connect-src` in dev includes `ws: http://localhost:* http://127.0.0.1:*`

- **Rule ID:** `JS-CSP-001`
- **Location:** [src/main/infrastructure/content-security-policy.ts:14](file:///f:/Agent/src/main/infrastructure/content-security-policy.ts#L14)
- **Evidence:** `connect-src 'self' ws: http://localhost:* http://127.0.0.1:*`
- **Impact:** Allows WebSocket + http to any localhost port in dev. If the
  dev machine is shared and another local service is listening, the
  renderer (e.g. via a compromised dev-server module) could exfiltrate
  data there. The `ws:` scheme without a host is broad. Dev-only.
- **Fix:** Replace `ws:` with the specific Vite HMR port. Replace
  `http://localhost:*` / `http://127.0.0.1:*` with the specific port.
- **Mitigation:** Document the dev-only relaxation.

### M-8. `openDevTools({ mode: "detach" })` enabled in dev unconditionally

- **Rule ID:** `DEVTOOLS-001` (informational)
- **Location:** [src/main/index.ts:128](file:///f:/Agent/src/main/index.ts#L128)
- **Evidence:** `mainWindow.webContents.openDevTools({ mode: "detach" })`
  inside the `ELECTRON_RENDERER_URL` branch.
- **Impact:** DevTools in detached mode can still be inspected by anyone
  with screen access. This is dev-only and not a code vulnerability, but
  in a desktop app used in a workplace it could expose data on screen.
- **Fix:** Leave as-is for dev; ensure the production branch (after the
  early return) does not call `openDevTools`. The current code is already
  correct — flagging for the record.
- **Mitigation:** None needed.

### M-9. Tool output text rendered via `<pre>` in the chat timeline

- **Rule ID:** `REACT-XSS-002` (positive control)
- **Location:** [src/renderer/src/ui/components/chat/ChatBlock.tsx:617-623, 666-672](file:///f:/Agent/src/renderer/src/ui/components/chat/ChatBlock.tsx#L617-L623)
- **Evidence:** `ToolBlock` renders `display.detail` via `<pre>{detailDisplay.text}</pre>`.
  React's JSX escaping handles this safely.
- **Impact:** None if the implementation is correct (it is). Verifying
  this in the report because tool output includes user-controlled data
  (e.g. shell stdout, file content, MCP server replies) and is a common
  sink. The current code is correct.
- **Fix:** None.
- **Mitigation:** None.

### M-10. `<a target="_blank" rel="noreferrer">` missing `noopener`

- **Rule ID:** `REACT-URL-001` (positive control / minor)
- **Location:** [src/renderer/src/ui/components/chat/AssistantMarkdown.tsx:64-72](file:///f:/Agent/src/renderer/src/ui/components/chat/AssistantMarkdown.tsx#L64-L72)
- **Evidence:** External links use `rel="noreferrer"` only. `noreferrer`
  implies `noopener` in modern Chromium, but the safer convention is to
  set both explicitly. The renderer also never uses `window.open` and
  intercepts all `target=_blank` openings via `setWindowOpenHandler` in
  the main process.
- **Impact:** Tabnabbing risk on older runtimes if Electron's Chromium
  ever ships without the `noreferrer`→`noopener` implicit behavior.
  Current Electron does not have this issue.
- **Fix:** Set `rel="noopener noreferrer"` explicitly.
- **Mitigation:** None needed.

---

## Severity: LOW

### L-1. Renderer dev mode opens DevTools by default (informational)

Already noted in M-8.

### L-2. `import.meta.env` not used anywhere

- **Rule ID:** `REACT-CONFIG-001` (positive control)
- **Location:** Search of [src/renderer](file:///f:/Agent/src/renderer)
- **Evidence:** No `import.meta.env.VITE_*` or `process.env.REACT_APP_*`
  references were found. The Vite env story is clean.
- **Impact:** None.
- **Fix:** None.

### L-3. `window.matchMedia` and `document.documentElement.dataset.*` set in renderer

- **Rule ID:** `JS-DOMC-001` (informational)
- **Location:** [src/renderer/src/i18n/index.ts:72-75, 107-112](file:///f:/Agent/src/renderer/src/i18n/index.ts#L72-L75)
- **Evidence:** `document.documentElement.dataset.theme` and
  `dataset.platform` are set from `getInitialLocale()` /
  `loadBasicPreferences()` / `navigator.userAgent`.
- **Impact:** `localStorage` and `navigator.userAgent` are both attacker-
  influenced surfaces (extensions, XSS, but neither is in scope for this
  app). The values are coerced to a fixed enum (`light|dark` and
  `darwin|win32|linux`), so they cannot inject arbitrary `data-*` names.
- **Fix:** None needed.
- **Mitigation:** None.

### L-4. `i18next` `escapeValue: false` is correct for React

- **Rule ID:** `REACT-XSS-002` (positive control)
- **Location:** [src/renderer/src/i18n/index.ts:156-159](file:///f:/Agent/src/renderer/src/i18n/index.ts#L156-L159)
- **Evidence:** `interpolation: { escapeValue: false }`.
- **Impact:** i18next with `escapeValue: false` skips its own escaping and
  relies on React's JSX escaping. All translations are passed through
  `t(...)` and rendered via `{t(...)}` or `<Component>{t(...)}</Component>`,
  so React escapes the values. Correct.
- **Fix:** None.
- **Mitigation:** None.

### L-5. `webContents.send` is the only renderer-facing push channel

- **Rule ID:** `SSE-PUSH-001` (positive control)
- **Location:** [src/main/ipc/sse-handlers.ts:35-108](file:///f:/Agent/src/main/ipc/sse-handlers.ts#L35-L108)
- **Evidence:** All events flow through `webContents.send(SSE_PUSH_CHANNEL, evt)`
  and the renderer guards payloads with `isRuntimeEvent(payload)` in
  [src/preload/index.ts:174-181](file:///f:/Agent/src/preload/index.ts#L174-L181).
- **Impact:** Prevents untrusted payloads from reaching renderer
  subscribers. Positive finding.
- **Fix:** None.

### L-6. Worker pool error path leaks `requestId`

- **Rule ID:** `LLM-WORKER-ERR-001` (informational)
- **Location:** [src/main/infrastructure/llm-worker/worker-pool.ts:125-128](file:///f:/Agent/src/main/infrastructure/llm-worker/worker-pool.ts#L125-L128)
- **Evidence:** `LLM worker exited before completing request ${requestId}…`
- **Impact:** `requestId` is a UUID generated per chat; it is not a
  secret. The error message is non-sensitive.
- **Fix:** None.

### L-7. `MAX_COMMAND_OUTPUT_BYTES` style caps for MCP

- **Rule ID:** `MCP-OUTPUT-CAP-001` (positive control)
- **Location:** [src/main/application/constants.ts](file:///f:/Agent/src/main/application/constants.ts),
  [src/main/infrastructure/mcp/stdio-transport.ts:215-222](file:///f:/Agent/src/main/infrastructure/mcp/stdio-transport.ts#L215-L222),
  [src/main/infrastructure/mcp/http-transport.ts:147-153](file:///f:/Agent/src/main/infrastructure/mcp/http-transport.ts#L147-L153)
- **Evidence:** MCP stdio and HTTP transports both cap message size
  (`MCP_MAX_MESSAGE_BYTES`) and the stdio stderr is bounded
  (`MCP_STDERR_BUFFER_BYTES`). The tool output paths also use
  bounded collectors.
- **Impact:** Prevents a malicious MCP server from OOM-ing the main
  process. Positive finding.
- **Fix:** None.

### L-8. Tool registry is mutable from MCP and approval coordinator

- **Rule ID:** `TOOL-REGISTRY-001` (informational)
- **Location:** [src/main/application/tools/in-memory-tool-registry.ts](file:///f:/Agent/src/main/application/tools/in-memory-tool-registry.ts),
  [src/main/infrastructure/mcp/host.ts:411-417](file:///f:/Agent/src/main/infrastructure/mcp/host.ts#L411-L417)
- **Evidence:** `McpHost.replaceServerTools` registers / unregisters tools
  at runtime. Names are namespaced
  (`namespaceMcpToolName(serverName, rawName)`).
- **Impact:** A malicious MCP server can register a tool whose name
  collides with a built-in if the namespace is not enforced. The
  `namespaceMcpToolName` helper appears to prefix with the server name,
  so collisions are unlikely — but verify the `toMcpNameSegment`
  sanitization is robust against `__` injection.
- **Fix:** Verify that `toMcpNameSegment` strips `__` from server names
  (so a server named `foo__bar` cannot impersonate a built-in tool).
- **Mitigation:** None.

---

## Severity: INFORMATIONAL (positive findings)

The following were checked and found to be correctly implemented. They are
listed for completeness so future reviews can confirm they are still
in place.

### P-1. Electron security baseline is correct

- [src/main/index.ts:114-119](file:///f:/Agent/src/main/index.ts#L114-L119):
  `contextIsolation: true`, `nodeIntegration: false`, explicit `preload`.
- Preload uses `contextBridge.exposeInMainWorld("agentApi", ...)` and does
  not expose `ipcRenderer`, `require`, `process`, or `Buffer` to the
  renderer ([src/preload/index.ts:472-489](file:///f:/Agent/src/preload/index.ts#L472-L489)).

### P-2. No DOM XSS sinks in the renderer

- `dangerouslySetInnerHTML`, `__html:`, `innerHTML`, `outerHTML`,
  `insertAdjacentHTML`, `document.write`, `document.writeln`,
  `eval(`, `new Function`, `setTimeout("…")`, `setInterval("…")` — none
  found in [src/renderer](file:///f:/Agent/src/renderer).

### P-3. `react-markdown` is configured safely

- [src/renderer/src/ui/components/chat/AssistantMarkdown.tsx:49](file:///f:/Agent/src/renderer/src/ui/components/chat/AssistantMarkdown.tsx#L49):
  `<ReactMarkdown ... remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>`
  — no `rehype-raw`, no `allowDangerousHtml`. Custom `a` and `img` component
  overrides reject non-`http(s)` URLs and unsafe `data:` image payloads.

### P-4. External navigation restricted to `http(s)`

- [src/main/infrastructure/electron-window.ts:5-31](file:///f:/Agent/src/main/infrastructure/electron-window.ts#L5-L31):
  `setWindowOpenHandler` only delegates `http(s)` URLs to
  `shell.openExternal`. `will-navigate` is denied for anything that
  is not the renderer index file or the dev server origin.

### P-5. Workspace path policy is multi-layered

- [src/main/application/tools/workspace-policy.ts](file:///f:/Agent/src/main/application/tools/workspace-policy.ts):
  lexical `path.resolve` + `isPathInsideOrEqual` + `fs.realpath` +
  `fs.lstat` for symlink-in-path + per-segment `isSkippedSegment`
  (covers dotfiles, `node_modules`, `out`, `dist`, `DeepSeek`,
  `external-references`).

### P-6. `O_NOFOLLOW` + post-open lstat recheck (TOCTOU defense)

- [src/main/application/tools/text-file.ts:75-149](file:///f:/Agent/src/main/application/tools/text-file.ts#L75-L149):
  POSIX path uses `O_NOFOLLOW` atomically; Windows path opens without
  `O_TRUNC` and re-lstats before truncating.

### P-7. Atomic writes (`tmp + fsync + rename`)

- [src/main/persistence/attachment-store.ts:137-147](file:///f:/Agent/src/main/persistence/attachment-store.ts#L137-L147)
- [src/main/persistence/config-file.ts:136-151](file:///f:/Agent/src/main/persistence/config-file.ts#L136-L151)
- [src/main/infrastructure/mcp/cache-store.ts:166-177](file:///f:/Agent/src/main/infrastructure/mcp/cache-store.ts#L166-L177)
- [src/main/persistence/checkpoint-store.ts:287-300](file:///f:/Agent/src/main/persistence/checkpoint-store.ts#L287-L300)
- All four persisters use the tmp+rename pattern. JSONL stores use
  fsync-on-append. Positive finding.

### P-8. API key encryption at rest via Electron `safeStorage`

- [src/main/persistence/secret-codec.ts:24-44](file:///f:/Agent/src/main/persistence/secret-codec.ts#L24-L44):
  `SafeStorageSecretCodec.encrypt` calls
  `safeStorage.encryptString(...).toString("base64")`.
- Wired through
  [src/main/persistence/model-config-store.ts:28-29](file:///f:/Agent/src/main/persistence/model-config-store.ts#L28-L29)
  and
  [src/main/persistence/config-file.ts:75](file:///f:/Agent/src/main/persistence/config-file.ts#L75).
- Falls back to `MissingSecretCodec` if `safeStorage` is not available,
  which throws — so an unencrypted key cannot accidentally be written.

### P-9. LLM HTTP runs in `worker_threads`

- [src/main/infrastructure/llm-worker/worker.ts](file:///f:/Agent/src/main/infrastructure/llm-worker/worker.ts):
  Worker owns a single `MiniMaxGateway` instance and handles `chat` /
  `cancel` messages. `AbortController` is per-`requestId` and
  terminates in-flight HTTP streams on cancel.

### P-10. Command sandbox: `shell: false`, detached, credential-filtered env

- [src/main/application/tools/command-sandbox.ts:33-44](file:///f:/Agent/src/main/application/tools/command-sandbox.ts#L33-L44):
  `shell: false`, `detached: process.platform !== "win32"`,
  `stdio: [stdin, "pipe", "pipe"]`, `windowsHide: true`.
- [src/main/application/tools/command-environment.ts:42-51](file:///f:/Agent/src/main/application/tools/command-environment.ts#L42-L51):
  Filters env by sensitive-name allowlist (regexes catch
  `*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, AWS / Azure / GitHub /
  Stripe / Vercel / OpenAI / Anthropic / DeepSeek / MiniMax).

### P-11. Process-tree kill on Windows + POSIX

- [src/main/application/tools/command-process-runner.ts:152-197](file:///f:/Agent/src/main/infrastructure/llm-worker/command-process-runner.ts):
  Windows uses `taskkill /pid /t /f`; POSIX uses
  `process.kill(-child.pid, signal)`. Detached process group on
  non-Windows.

### P-12. All IPC handlers parse and validate payloads

- Every handler in
  [src/main/ipc](file:///f:/Agent/src/main/ipc) wraps logic in
  `try/catch` and returns `IpcResult<T> = { ok: true, value: T } | { ok: false, code, message }`.
  Request bodies are validated with type guards (e.g.
  [parseWriteGetRequest](file:///f:/Agent/src/main/ipc/write-handlers.ts#L143-L149),
  [parseModelConfigUpdateRequest](file:///f:/Agent/src/main/ipc/model-config-handlers.ts#L167-L234)).
  String fields check for NUL bytes.

### P-13. UUID-based attachment IDs with strict base64 / mime / size validation

- [src/main/persistence/attachment-store.ts:56-85, 156-198](file:///f:/Agent/src/main/persistence/attachment-store.ts#L56-L85):
  UUID-only IDs, 12MB max, mime-type allowlist, base64 strict validation
  (regex + decode round-trip check).

### P-14. SSE event type guard in preload

- [src/preload/index.ts:174-181](file:///f:/Agent/src/preload/index.ts#L174-L181):
  `if (!isRuntimeEvent(payload)) return;` before forwarding to
  subscribers. Prevents poisoned `webContents.send` payloads from
  reaching renderer code.

### P-15. `localStorage` is not used for sensitive data

- Searched: only `BASIC_PREFERENCES_STORAGE_KEY`,
  `LAST_WORKSPACE_STORAGE_KEY`, and `LANGUAGE_STORAGE_KEY` are stored
  (theme, followSystemTheme, lastWorkspacePath, locale). No tokens,
  no API keys, no JWTs.

### P-16. Tool approval gate covers coding / shell / MCP destructive ops

- [src/main/application/approval-coordinator.ts:36-110](file:///f:/Agent/src/main/application/approval-coordinator.ts):
  Approval resolution carries `scope: "once" | "session" | "persist_rule"`.
  Read-only workspace / developer / skill / `create_plan` / `update_goal`
  tools skip approval; the rest surface an `approval_requested` event
  to the renderer.

---

## Recommended remediation order

1. **H-1 / H-2** — add a scheme + host allowlist for `base_url` and
   `config.url` at the IPC / config-update boundary. This is the highest-
   leverage fix and reduces both the API key leak surface and the SSRF
   surface.
2. **H-3** — redact provider error bodies before embedding in thrown
   `Error` instances. Pair with M-3 (redact before logging) for defense-
   in-depth.
3. **H-4** — tighten production CSP (remove `style-src 'unsafe-inline'`,
   add `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`),
   and verify the CSP applies to the main document in a packaged build
   (if `onHeadersReceived` does not fire for `file://`, also emit a
   `<meta http-equiv>` in [index.html](file:///f:/Agent/src/renderer/index.html)).
4. **M-1** — make `package:win` sign by default, or document the
   trade-off.
5. **M-2** — validate MCP `command` against an allowlist and warn before
   first connect.
6. **M-3 / M-6** — central redacting logger.
7. **L-10** — verify `toMcpNameSegment` strips `__` from server names.

---

## How to verify

After remediation, re-run the static checks below to confirm no
regressions:

```bash
npm run typecheck
npm run test
npm run build
```

Then manually:

- Open the app in dev mode; in DevTools Network panel, confirm the CSP
  header is present on the index response and on all `connect-src` requests
  to `ws://localhost:*` are limited to the Vite HMR port.
- Configure a custom OpenAI-compatible provider with `base_url =
  file:///etc/passwd`; confirm the IPC handler rejects it with a traceable
  error.
- Configure an MCP stdio server with `command = rm -rf /`; confirm the
  spawn call fails (allowlist) or the UI requires explicit confirmation.
- Set a model profile to a deliberately-broken `base_url`; trigger a turn;
  confirm the error surfaced to the renderer does not contain the
  `Authorization` header.

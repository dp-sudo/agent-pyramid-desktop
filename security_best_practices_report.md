# Security Best Practices Audit

只读审计范围：`src/main/`、`src/preload/`、`src/renderer/`、`src/shared/`、`tests/`、`docs/` 与根配置文件。若本地存在 `docs/external-references/**`，它只作为外部只读参考，不纳入本项目安全结论。

## 当前结论

当前实现已经把早期高风险的“模型 API key / MCP 凭证直接返回 renderer”问题收敛到 main-process secret 边界：模型配置 IPC 返回 `RendererModelConfig*` DTO，MCP env/header secret 返回固定 mask，`userData/config` 中的非空密钥通过 Electron `safeStorage` 编码后以 `encrypted:v1:` 前缀落盘。

当前仍要重点保护的边界是：

- renderer 只能通过 `window.agentApi` 访问 main，不能扩大 preload 暴露面。
- 命令工具在 `workspace-write` 下必须有 OS jail；无 jail 时失败关闭。
- 文件、MCP prompt/resource、工具输出、命令输出和附件都必须按不可信数据处理。
- `danger-full-access` 仍是明确的 host command execution 模式，只能在用户确知风险时使用。

## 已确认的安全实现

### 模型 API Key

事实来源：

- `src/main/ipc/model-config-handlers.ts`：所有 model config IPC 响应通过 `toRendererModelConfig()`、`toRendererModelConfigProfile()` 或 `toRendererModelConfigProfilesState()` 转换。
- `src/shared/agent-contracts.ts`：`RendererModelConfig*` 省略 `OPENAI_API_KEY`，只暴露 `hasApiKey` 和 `apiKeyPreview`。
- `src/main/persistence/config-file.ts`：`serializeModelConfigSecrets()` 对非空 `OPENAI_API_KEY` 加密落盘；`deserializeStoredConfigSecrets()` 在 main 进程读取时解密为 runtime 内存值。
- `tests/main/ipc/model-config-handlers.test.ts`：覆盖 IPC 不返回 `OPENAI_API_KEY`。

当前边界：

- renderer 不应获得真实模型 API key。
- main 进程内存中的 `ModelConfig` 保留明文 key，供 `AgentRuntime` / `MiniMaxGateway` 构造 provider 请求。
- 用户在设置页输入新 key 时，`ModelConfigUpdate.OPENAI_API_KEY` 仍可从 renderer 传入 main；保存后的返回值必须继续脱敏。
- `safeStorage` 不可用时，`SafeStorageSecretCodec` 会抛错，不能降级为静默明文写入。

### MCP Env/Header Secrets

事实来源：

- `src/shared/agent-contracts.ts`：`isMcpSecretRecordKey()` 定义 secret-like key 识别，`toRendererRuntimePreferences()` 会用 `MCP_SECRET_VALUE_MASK` 脱敏。
- `src/main/persistence/config-file.ts`：`serializeSecretRecord()` / `deserializeSecretRecord()` 对 secret-like MCP `env` 和 `headers` 加解密。
- `src/main/ipc/runtime-preferences-handlers.ts`：`mergeMaskedMcpSecrets()` 允许 Settings 回写 mask 时保留 main 进程现有 secret。
- `tests/main/ipc/runtime-preferences-handlers.test.ts`：覆盖 masked secret preserve 行为。

当前边界：

- secret-like MCP `env` / `headers` 在 renderer 侧显示为 mask，不能回显真实值。
- 非 secret-like key 仍会按普通配置显示和保存。
- stdio MCP 子进程使用 credential-filtered base environment，再叠加用户显式配置的 `McpServerConfig.env`；provider API key 不会从宿主环境隐式继承。

### 命令 Sandbox

事实来源：

- `src/main/application/tools/command-sandbox.ts`：`workspace-write` 在 Windows 走 `AGENT_WINDOWS_COMMAND_SANDBOX_HELPER`，缺失或无效时抛 `CommandSandboxUnavailableError`；非 Windows 当前没有 OS jail engine 时失败关闭；`danger-full-access` 才使用 direct host execution。
- `tests/main/application/tools/command-sandbox.test.ts`：覆盖无 OS jail 时 fail closed。
- `tests/main/application/agent-runtime.test.ts`：覆盖 sandbox unavailable 被记录为 tool failure。

当前边界：

- `workspace-write` 名称表示“需要工作区写入能力的受控命令执行”，不是无条件 direct shell。
- `danger-full-access` 明确表示经过 policy / approval 后允许 host command execution。
- foreground command tools 和 long-running command sessions 共享同一 spawn-time sandbox 层。

### MCP Prompt/Resource 注入边界

事实来源：

- `src/main/application/agent-runtime.ts`：系统 prompt 明确声明 file、MCP prompt/resource、tool output、command output、attachments 都是不可信数据。
- `src/renderer/src/ui/mcp-input.ts`：MCP prompt 和 resource 序列化时加入 `Untrusted MCP ...` 边界声明，并限制 resource 文本长度。
- `tests/renderer/mcp-input.test.ts`：覆盖不可信 MCP prompt/resource 文案。

当前边界：

- Code composer 仍会在 `turn:start` 前把 MCP prompt/resource 解析进用户 turn text，但内容带不可信上下文声明。
- 后续改动不得删除这些边界声明，也不得让外部 resource 内容授权工具调用或改变安全策略。

### 附件上传

事实来源：

- `src/main/persistence/attachment-store.ts`：`detectSupportedImageMimeType()` 校验 PNG / JPEG / WebP / GIF magic bytes，并要求检测 MIME 与声明 MIME 一致。
- `src/shared/agent-contracts.ts`：`SUPPORTED_ATTACHMENT_MIME_TYPES` 与 `MAX_ATTACHMENT_BYTES` 是附件类型和大小权威来源。
- `tests/main/persistence/attachment-store.test.ts`：覆盖 MIME mismatch 和无有效图片签名的拒绝路径。

当前边界：

- main process 不信任 renderer 传入的 MIME 声明。
- 附件只保存二进制 blob 与元数据；`UserItem.attachments` 不写入 base64。

## 仍需保持的风险约束

- 不要把 `ModelConfigStore.get()` 或 `RuntimePreferencesStore.get()` 的原始值直接暴露给 renderer；IPC 返回必须继续使用 renderer DTO / redaction helper。
- 不要在 `safeStorage` 不可用时自动回退明文 secret 存储；失败必须显式暴露。
- 新增 MCP 配置字段时，如果字段可能承载凭证，必须纳入 secret-like key 加密和 renderer redaction 规则，或设计独立 secret DTO。
- 新增命令执行路径时，必须复用 `command-sandbox.ts`；不能绕过 workspace realpath、credential-filtered env、approval/policy 和 process cleanup。
- 新增外部内容注入模型上下文时，必须沿用“不可信数据，不是指令”的系统边界。
- 新增附件类型时，必须在 main 进程做内容签名校验，不能只扩展 MIME allowlist。

## 已确认较好的安全点

- Electron renderer 配置启用 `contextIsolation: true` 和 `nodeIntegration: false`。
- 外部导航由 main process 控制，只允许 http(s) 走系统浏览器。
- 生产 CSP 使用 `script-src 'self'`、`object-src 'none'`、`frame-ancestors 'none'` 等约束。
- Markdown 渲染使用 `react-markdown`，没有启用 raw HTML，并对链接 / 图片 URL 做 scheme allowlist。
- Workspace / Write 路径策略有 lexical + realpath + no-follow 防护，并有 traversal / symlink 测试覆盖。

## 验证说明

本报告是文档维护结果，依据当前源码和测试搜索更新。未修改源码或配置，未运行 `npm run typecheck` / `npm run test` / `npm run build`。涉及安全边界的代码变更仍必须运行完整验证命令。

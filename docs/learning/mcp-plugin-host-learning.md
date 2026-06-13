# MCP 外部插件 Host 机制学习笔记（阶段 1）

本文只做机制学习与本项目现状对照，不包含实现方案、代码或伪代码。所有结论均附文件路径和行号证据。

> 后续状态说明：本文第 4、5 节记录的是阶段 1 实施前的仓库现状。阶段 2 已在本仓库独立实现 MCP stdio / Streamable HTTP、tools 动态注册、prompts/resources IPC surface、Settings MCP Servers 面板、Code composer 的 `/mcp__server__prompt` 与 `@server:uri` 输入注入、schema cache、startup stats、lazy reconnect placeholder 和 HTTP auth 诊断。当前状态以 `docs/ipc-contracts.md`、`docs/runtime-flow.md`、`docs/data-model.md` 和源码为准；本文保留为学习证据记录。

## 0. Pre-Flight Manifest

```yaml
[Pre-Flight Manifest]
Task_Goal: "学习 MCP host 机制设计与逻辑构成，对照本项目现有 MCP 雏形，产出阶段 2 可消费的学习笔记。"
Pre_Conditions:
  - "Reasonix 端已确认存在：docs/external-references/Reasonix/internal/plugin、internal/mcpdiag、internal/agent、internal/control、internal/permission、internal/sandbox、internal/event、internal/tool。"
  - "Reasonix 文档已确认存在：docs/external-references/Reasonix/docs/GUIDE.md、docs/external-references/Reasonix/docs/SPEC.md、docs/external-references/Reasonix/REASONIX.md。"
  - "Claude Code 样本已确认存在：docs/external-references/claude code/.claude/skills/interview/SKILL.md、docs/external-references/claude code/.claude/skills/teach-me/SKILL.md、docs/external-references/claude code/.claude/skills/teach-me/references/pedagogy.md、docs/external-references/claude code/.claude/agents/hello-agent.md。"
  - "Claude Code commands 样本未在 docs/external-references/claude code 下发现；本文只记录未发现，不构造路径。"
  - "本项目端已确认存在：src/main/infrastructure/mcp/{client.ts,host.ts,protocol.ts,stdio-transport.ts}、src/main/ipc/mcp-handlers.ts、src/main/index.ts、src/shared/agent-contracts.ts、src/shared/ipc.ts、src/preload/index.ts、src/renderer/src/global.d.ts、src/main/application/agent-runtime.ts、src/main/application/permission-policy.ts、src/main/persistence/、src/renderer/src/ui/。"
  - "本项目 tests/main/{ipc,infrastructure}/mcp-* 未发现；本文标注为未落地/未发现。"
Core_Assumptions:
  - "假设A：Reasonix 的 MCP/plugin host 学习主线应以 internal/plugin 为核心，因为该目录定义 Spec、transport、Host、Client、remoteTool、cache/lazy 与 transport 实现。"
  - "假设B：Reasonix 的 MCP 诊断范围集中在 auth 诊断，internal/mcpdiag/auth.go 只处理远程传输鉴权状态、鉴权材料检测与清理。"
  - "假设C：本项目 MCP 雏形是 tools-only，src/main/infrastructure/mcp/client.ts 明确 prompts/resources/roots/sampling 不在第一版 host 内。"
  - "假设D：阶段 1 交付物只允许写入 docs/learning/mcp-plugin-host-learning.md，不修改 src、tests、配置或参考源码。"
Uncertainties:
  - "Claude Code .claude/commands/** 在给定样本根下未发现，无法做文件样本级细节对比。"
  - "本项目英文 i18n 中 MCP 设置文案未通过搜索命中，可能存在 UI 文案不完整；本文只记录现状，不修复。"
Alternative_Paths:
  - "路径 A：按用户给定顺序深读 Reasonix plugin -> mcpdiag/agent/control/permission/sandbox/event/tool -> 文档 -> Claude 样本 -> 本项目对照。优点是覆盖顺序严格、证据链完整；缺点是耗时较长。本文采用此路径。"
  - "路径 B：先从本项目 MCP 雏形倒推缺口，再定向查 Reasonix。优点是更快形成差距清单；缺点是可能遗漏 Reasonix host 机制的上游设计意图。"
Verification_Strategy: "三档证据：Reasonix 证据使用 docs/external-references/Reasonix 下文件路径+行号；Claude 样本证据使用 docs/external-references/claude code/.claude 下文件路径+行号，并明确 commands 未发现；本项目对照证据使用 src/tests/docs 下文件路径+行号，逐项标注 已落地/部分落地/未落地/不适用。完成后校验只写目标文档、无代码片段超限、无无证据事实。"
```

## 1. Reasonix 源码学习

### 1.1 internal/plugin：host 的职责边界

- Reasonix 明确把 `plugin` 包定义为 MCP client：连接外部 MCP servers，并把远端 tools 适配为统一 `tool.Tool`，让 agent 以同一种方式看待插件工具与内置工具。证据：`docs/external-references/Reasonix/internal/plugin/plugin.go:1-6`。
- `Spec` 是外部 server 的声明入口，字段覆盖 server 名称、传输类型、stdio command/args/env、HTTP URL/headers、工作目录、stderr 镜像、只读工具名覆盖、原始名前缀剥离和低优先级进程。证据：`docs/external-references/Reasonix/internal/plugin/plugin.go:29-62`。
- MCP 协议层与传输层分离：`transport` 只暴露 call/notify/close，server 主动消息被忽略，Reasonix 是 tools/prompts/resources consumer，不是 sampling/roots provider。证据：`docs/external-references/Reasonix/internal/plugin/plugin.go:64-73`。
- `Host` 拥有运行中的 plugin connections，并聚合 prompts/resources/failures；它还维护 deferred startup cancel、wait group 和后台 cache/stats 写入等待。证据：`docs/external-references/Reasonix/internal/plugin/plugin.go:75-99`。
- `Host.Prompts()`、`Resources()`、`ServerNames()` 返回快照，`ReadResource()` 先定位 server，再在锁外执行网络读取。证据：`docs/external-references/Reasonix/internal/plugin/plugin.go:101-143`。

### 1.2 启动策略、失败隔离与生命周期

- `StartPolicy` 以单 server 超时、并发上限和 abort 策略控制批量启动；默认并发为 8，默认单插件启动超时为 5 秒。证据：`docs/external-references/Reasonix/internal/plugin/plugin.go:145-176`。
- `StartAll()` 是严格模式，任何 server 失败会清理已启动连接并返回错误；`StartAvailable()` 是宽容模式，会记录失败并继续连接其他 server。证据：`docs/external-references/Reasonix/internal/plugin/plugin.go:178-202`。
- `Start()` 的 phase A 先启动传输、initialize、tools/list，并把 startup stats 与 schema cache 写入放到后台；prompts/resources 被推迟到 phase B。证据：`docs/external-references/Reasonix/internal/plugin/plugin.go:204-343`。
- `Close()` 会先取消 deferred lazy/background startup，再等待它们结束，然后关闭 client 快照并等待后台写入完成，避免刚连上的 stdio child 逃过 teardown。证据：`docs/external-references/Reasonix/internal/plugin/plugin.go:345-368`。
- `StartPhaseB()` 异步获取 prompts/resources，并通过 `MCPSurfaceReady` 通知 UI 刷新；这些辅助 surface 的错误只记录日志，不中断会话。证据：`docs/external-references/Reasonix/internal/plugin/plugin.go:370-389`、`docs/external-references/Reasonix/internal/plugin/plugin.go:392-445`。
- 热添加 `Host.Add()` 要求 session-scoped context，因为 stdio child 的生命周期不能绑定到单个 turn；热移除 `Host.Remove()` 会关闭连接并返回 `mcp__<server>__` 前缀供 registry 清理。证据：`docs/external-references/Reasonix/internal/plugin/plugin.go:618-668`、`docs/external-references/Reasonix/internal/plugin/plugin.go:670-710`。

### 1.3 MCP 握手、工具适配与命名空间

- `start()` 用 lifeCtx 建立 transport 生命周期，用 callCtx 限制 initialize；`newTransport()` 支持 stdio 与 Streamable HTTP，legacy sse 被识别但返回明确错误。证据：`docs/external-references/Reasonix/internal/plugin/plugin.go:712-753`。
- `initialize()` 发送 protocolVersion、clientInfo，解析 server capabilities，并只在 server 宣告 prompts/resources 能力时调用对应 list 方法。证据：`docs/external-references/Reasonix/internal/plugin/plugin.go:765-786`。
- `listTools()` 调用 `tools/list`，读取 `annotations.readOnlyHint`，应用可信 Spec read-only override，把远端工具转换为 `remoteTool` 并记录 rawName。证据：`docs/external-references/Reasonix/internal/plugin/plugin.go:788-838`。
- 远端工具名被规范为 `mcp__<server>__<tool>`；不合法字符被替换并追加短 hash，空名回退为 `unnamed`。证据：`docs/external-references/Reasonix/internal/plugin/plugin.go:840-870`。
- `remoteTool.Execute()` 将模型参数转为 map 后调用 MCP `tools/call {name, arguments}`，并把 text content flatten 为给模型的文本；`isError` 会转为错误。证据：`docs/external-references/Reasonix/internal/plugin/plugin.go:904-970`。

### 1.4 stdio 与 HTTP transport

- stdio transport 使用子进程 stdin/stdout 上的 newline-delimited JSON-RPC，并用专门 reader goroutine 按 id 分发 response；context cancel 要能让 call 立即返回。证据：`docs/external-references/Reasonix/internal/plugin/transport_stdio.go:23-46`。
- stdio 启动会合并环境变量、解析 command，可设置 cwd、低优先级与 stderr tail；命令缺失时给出 PATH 修复建议。证据：`docs/external-references/Reasonix/internal/plugin/transport_stdio.go:48-98`、`docs/external-references/Reasonix/internal/plugin/transport_stdio.go:102-136`。
- HTTP transport 支持 Streamable HTTP：每个 JSON-RPC 消息是 POST，响应可以是 JSON 或 SSE；获得 `Mcp-Session-Id` 后后续请求回传该 header。证据：`docs/external-references/Reasonix/internal/plugin/transport_http.go:19-38`、`docs/external-references/Reasonix/internal/plugin/transport_http.go:106-128`。
- HTTP 响应体最大读取 16MiB；SSE reader 只提取匹配 id 的 JSON-RPC response，跳过通知和其他 id。证据：`docs/external-references/Reasonix/internal/plugin/transport_http.go:15-17`、`docs/external-references/Reasonix/internal/plugin/transport_http.go:130-183`。

### 1.5 cache、lazy/background 与可观测性

- schema cache 是纯优化：按 Spec fingerprint 持久化 tool schema 与 capabilities，坏 JSON、hash mismatch 或缺文件都退化为重新 handshake。证据：`docs/external-references/Reasonix/internal/plugin/cache.go:1-9`、`docs/external-references/Reasonix/internal/plugin/cache.go:53-63`、`docs/external-references/Reasonix/internal/plugin/cache.go:95-119`。
- cache 写入使用 tmpfile + rename，避免崩溃留下半截 JSON。证据：`docs/external-references/Reasonix/internal/plugin/cache.go:121-167`。
- lazy plugin 在启动时注册 placeholder；cache hit 时 placeholder 持有真实 schema，首次 Execute 同步 handshake 并转发；cache miss 时只暴露 connect stub，首次调用触发异步 spawn 并要求下一 turn 重试。证据：`docs/external-references/Reasonix/internal/plugin/lazy.go:1-11`、`docs/external-references/Reasonix/internal/plugin/lazy.go:123-147`、`docs/external-references/Reasonix/internal/plugin/lazy.go:150-225`。
- lazy/background 共享同一个 `lazySpawn` 状态机，状态转移通过 mutex 保护，避免多个 Execute 并发重复握手。证据：`docs/external-references/Reasonix/internal/plugin/lazy.go:30-49`、`docs/external-references/Reasonix/internal/plugin/lazy.go:68-106`。
- startup stats 记录最近启动耗时，并用于 Recommend 判断慢插件是否 demote 到 lazy；错误只记录，不阻断启动。证据：`docs/external-references/Reasonix/internal/plugin/stats.go:1-10`、`docs/external-references/Reasonix/internal/plugin/stats.go:49-58`、`docs/external-references/Reasonix/internal/plugin/stats.go:104-151`。

### 1.6 prompts/resources surface

- MCP resource 在 chat 中以 `@<server>:<uri>` 引用，读取后把 text 内容拼接；blob 不解码，只说明二进制资源被省略。证据：`docs/external-references/Reasonix/internal/plugin/resources.go:10-19`、`docs/external-references/Reasonix/internal/plugin/resources.go:50-80`。
- MCP prompt 以 `/mcp__<server>__<prompt>` slash command 暴露，positional args 按 prompt declared arguments 映射。证据：`docs/external-references/Reasonix/internal/plugin/prompts.go:10-28`、`docs/external-references/Reasonix/internal/control/input.go:249-285`。
- controller 的 reference 解析会把 connected server 的 `server:uri` 识别为 MCP resource，并在 `ResolveRefs()` 中调用 `host.ReadResource()`。证据：`docs/external-references/Reasonix/internal/control/refs.go:73-90`、`docs/external-references/Reasonix/internal/control/refs.go:105-113`、`docs/external-references/Reasonix/internal/control/refs.go:288-300`。

### 1.7 tool、agent、permission、sandbox、event、control 的接入关系

- `tool.Tool` 是模型可调用能力，包含 Name/Description/Schema/Execute/ReadOnly；runtime registry 是 enabled built-ins 加 plugin tools，agent 只看 registry。证据：`docs/external-references/Reasonix/internal/tool/tool.go:1-4`、`docs/external-references/Reasonix/internal/tool/tool.go:18-33`、`docs/external-references/Reasonix/internal/tool/tool.go:99-125`。
- registry 支持按 prefix 移除 MCP server 工具，专门用于断开 server 时删除 `mcp__<server>__` 命名空间。证据：`docs/external-references/Reasonix/internal/tool/tool.go:127-149`。
- agent 在执行 batch 时让连续 ReadOnly 工具并行运行，unknown 或 writer 工具保持单个串行 batch；plan mode 会拒绝非 ReadOnly 工具。证据：`docs/external-references/Reasonix/internal/agent/agent.go:1023-1124`、`docs/external-references/Reasonix/internal/agent/agent.go:170-179`、`docs/external-references/Reasonix/internal/agent/agent.go:1251-1274`。
- permission policy 是纯规则层，优先级是 deny > ask > allow > fallback；readOnly 工具默认 allow。证据：`docs/external-references/Reasonix/internal/permission/permission.go:106-150`。
- permission gate 在 execute time 接入 approver，非交互模式下 Ask 会 allow，但 Deny 仍硬阻断。证据：`docs/external-references/Reasonix/internal/permission/permission.go:286-353`。
- sandbox 是 permission 之下的 enforcement 层，bash 在支持平台上被 OS jail 限制写入和网络；不支持平台 fallback unwrapped。证据：`docs/external-references/Reasonix/internal/sandbox/sandbox.go:1-10`、`docs/external-references/Reasonix/internal/sandbox/sandbox.go:13-30`。
- event 定义了 `MCPSurfaceReady`，用于 prompts/resources 背景加载完成后刷新 `/mcp` 状态。证据：`docs/external-references/Reasonix/internal/event/event.go:75-79`。
- controller 持有 `plugin.Host`、live tool registry 和 session-scoped `pluginCtx`，热添加 MCP server 后把 tools 注册到 registry，移除时按 prefix 清理。证据：`docs/external-references/Reasonix/internal/control/controller.go:93-99`、`docs/external-references/Reasonix/internal/control/controller.go:2057-2116`、`docs/external-references/Reasonix/internal/control/controller.go:2249-2300`。
- `/mcp` slash 支持 connect/show/tools/remove/import 等候选项，`/mcp connect <name>` 会连接配置 server，`mcpListText()` 展示连接 server 和失败记录。证据：`docs/external-references/Reasonix/internal/control/slash.go:168-217`、`docs/external-references/Reasonix/internal/control/slash.go:370-380`、`docs/external-references/Reasonix/internal/control/slash.go:512-532`。

### 1.8 internal/mcpdiag

- `mcpdiag` 当前聚焦远程 MCP 鉴权诊断：识别 401/403/unauthorized 等 auth failure，并区分 none/possible/required。证据：`docs/external-references/Reasonix/internal/mcpdiag/auth.go:8-34`、`docs/external-references/Reasonix/internal/mcpdiag/auth.go:36-53`。
- 它能检测 headers/env/url 中的 token、api key、bearer 等鉴权材料，并提供清理 headers/env/url 中鉴权材料的函数。证据：`docs/external-references/Reasonix/internal/mcpdiag/auth.go:55-83`、`docs/external-references/Reasonix/internal/mcpdiag/auth.go:110-184`。

### 1.9 Reasonix 测试约束中体现的 host 不变量

- stdio e2e 测试覆盖真实子进程 helper 的 StartAll、tools/list 和 tools/call。证据：`docs/external-references/Reasonix/internal/plugin/plugin_test.go:19-56`。
- StartAvailable 测试固定“坏 server 不影响好 server”的失败隔离；StartAll 测试固定“任一失败则全量失败并清理”。证据：`docs/external-references/Reasonix/internal/plugin/plugin_test.go:98-123`、`docs/external-references/Reasonix/internal/plugin/plugin_test.go:125-163`。
- HTTP transport 测试覆盖 JSON/SSE 响应、session id、Authorization header 和 readOnlyHint。证据：`docs/external-references/Reasonix/internal/plugin/transport_http_test.go:16-122`。
- lazy 测试固定 cache-hit 首次执行可同步转发、cache-miss 先暴露 connect stub 并下一 turn 才看到真实工具。证据：`docs/external-references/Reasonix/internal/plugin/lazy_test.go:75-144`、`docs/external-references/Reasonix/internal/plugin/lazy_test.go:185-240`。
- registry 测试固定按 `mcp__<server>__` 前缀移除不会影响其他 server 工具。证据：`docs/external-references/Reasonix/internal/tool/registry_test.go:26-63`。

## 2. Reasonix 文档学习

- `SPEC.md` 把插件作为两层扩展之一：compile-time built-ins 与 runtime external plugins，后者是 stdio JSON-RPC subprocesses、MCP-compatible。证据：`docs/external-references/Reasonix/docs/SPEC.md:17-19`。
- `SPEC.md` 的 plugin 章节与源码一致：外部 plugin 是 config 声明的 MCP server，传输可为 stdio/http，sse 被识别但 deferred。证据：`docs/external-references/Reasonix/docs/SPEC.md:116-134`。
- 文档规定 `${VAR}` 与 `${VAR:-default}` 在 command/args/env/url/headers 中展开，让 secrets 来自环境而不是配置文件。证据：`docs/external-references/Reasonix/docs/SPEC.md:135-136`。
- 文档规定 lifecycle 是 initialize -> notifications/initialized -> tools/list，调用是 tools/call；远端 tools 注入 registry 并以 `mcp__<server>__<tool>` 命名。证据：`docs/external-references/Reasonix/docs/SPEC.md:137-141`。
- 文档规定 readOnlyHint 映射到 `Tool.ReadOnly()`，默认 false，只有声明 readOnlyHint 的远端工具才进入并行调度和 reader-default permission。证据：`docs/external-references/Reasonix/docs/SPEC.md:142-145`。
- 文档规定 prompts/resources 的 UI 入口分别是 `/mcp__<server>__<prompt>` 与 `@<server>:<uri>`。证据：`docs/external-references/Reasonix/docs/SPEC.md:146-148`。
- `GUIDE.md` 面向用户说明 `[[plugins]]` 支持 stdio 与 Streamable HTTP，tools 暴露为 `mcp__<server>__<tool>`，readOnlyHint 接入并行调度与 permission reader-default。证据：`docs/external-references/Reasonix/docs/GUIDE.md:141-149`。
- `GUIDE.md` 说明 enabled MCP servers 会在 session 开始后后台连接，用户可通过 `/mcp` 或桌面 MCP panel 刷新状态、重连、查看失败或禁用 server。证据：`docs/external-references/Reasonix/docs/GUIDE.md:170-173`。
- `GUIDE.md` 说明项目根 `.mcp.json` 的 `mcpServers` schema 会 field-for-field 映射到 `[[plugins]]`，并与 reasonix.toml 合并。证据：`docs/external-references/Reasonix/docs/GUIDE.md:175-178`。
- `REASONIX.md` 是每个 session 的 system prompt cache-stable prefix，要求添加行为到 transport-agnostic `control.Controller`，不要只加到某个 frontend。证据：`docs/external-references/Reasonix/REASONIX.md:3-16`。

## 3. Claude Code 样本对比

### 3.1 已发现样本

- `interview` skill 以 frontmatter 声明 name 和 description，正文定义触发后的行为规则。证据：`docs/external-references/claude code/.claude/skills/interview/SKILL.md:1-12`。
- `teach-me` skill 以 frontmatter 声明 name/description，并用文档正文描述 usage、arguments、workflow 和持久化记录目录。证据：`docs/external-references/claude code/.claude/skills/teach-me/SKILL.md:1-25`、`docs/external-references/claude code/.claude/skills/teach-me/SKILL.md:36-65`。
- `teach-me` skill 引用自己的 references 目录，样本中 `pedagogy.md` 是供 skill 使用的教学参考资料。证据：`docs/external-references/claude code/.claude/skills/teach-me/references/pedagogy.md:1-17`。
- `.claude/agents/hello-agent.md` 同样使用 frontmatter 声明 name/description，正文是 agent persona 与任务说明。证据：`docs/external-references/claude code/.claude/agents/hello-agent.md:1-17`。
- `.claude/commands/**` 在给定样本根 `docs/external-references/claude code` 下未发现，因此本文不构造 commands 样本事实。证据：当前文件清单只发现 `.claude/agents/hello-agent.md`、两个 `SKILL.md` 和一个 references 文件，见本任务只读搜索结果；未发现 commands 文件。

### 3.2 Skill/command 文件发现机制 vs MCP 插件发现机制

- Claude skill 样本是文件系统发现：一个目录下的 `SKILL.md` frontmatter 提供 name/description，正文是 prompt/workflow 说明；这类机制主要把“文档化能力”注入 agent 行为。证据：`docs/external-references/claude code/.claude/skills/interview/SKILL.md:1-7`、`docs/external-references/claude code/.claude/skills/teach-me/SKILL.md:1-8`。
- Reasonix custom command 也是文件系统发现：Markdown 文件位于 `.reasonix/commands/` 或用户 config commands 目录，文件名转为 slash command，正文作为 prompt template。证据：`docs/external-references/Reasonix/docs/GUIDE.md:194-218`、`docs/external-references/Reasonix/docs/SPEC.md:293-324`。
- MCP 插件发现不是单纯读取 prompt 文件，而是配置声明 server 后启动外部进程或远程连接，并通过 initialize/tools/list/prompts/list/resources/list 动态发现工具和 surface。证据：`docs/external-references/Reasonix/docs/SPEC.md:116-148`、`docs/external-references/Reasonix/internal/plugin/plugin.go:178-213`、`docs/external-references/Reasonix/internal/plugin/plugin.go:805-838`。
- Skill/command 的主要产物是 prompt 文本或操作说明；MCP host 的主要产物是 live tool adapter、server status、connection failure、prompts/resources surface 与可执行 tool calls。证据：Claude skill frontmatter/body 位于 `docs/external-references/claude code/.claude/skills/teach-me/SKILL.md:1-65`；Reasonix host/tool/status 结构位于 `docs/external-references/Reasonix/internal/plugin/plugin.go:75-99`、`docs/external-references/Reasonix/internal/plugin/plugin.go:481-502`、`docs/external-references/Reasonix/internal/plugin/plugin.go:904-970`。

## 4. 本项目现状对照

### 4.1 `src/main/infrastructure/mcp/`：部分落地

- 已落地：本项目已有 `protocol.ts`，定义 JSON-RPC request/notification/response、MCP protocol version、tools/list result normalization、tools/call result normalization 与 text serialization。证据：`src/main/infrastructure/mcp/protocol.ts:3-34`、`src/main/infrastructure/mcp/protocol.ts:72-111`。
- 已落地：`McpClient` 实现 tools-only MCP lifecycle：initialize、initialized notification、tools/list、tools/call。它明确把 prompts/resources/roots/sampling 排除在 first host 之外。证据：`src/main/infrastructure/mcp/client.ts:30-34`、`src/main/infrastructure/mcp/client.ts:54-87`、`src/main/infrastructure/mcp/client.ts:101-124`。
- 已落地：工具命名空间为 `mcp__server__tool`，并支持从 toolName 转 permission value。证据：`src/main/infrastructure/mcp/client.ts:142-155`。
- 已落地：stdio transport 使用 Node child_process spawn，newline JSON-RPC，pending map，notification listener，stderr tail，message size cap 和 abort handling。证据：`src/main/infrastructure/mcp/stdio-transport.ts:30-72`、`src/main/infrastructure/mcp/stdio-transport.ts:75-110`、`src/main/infrastructure/mcp/stdio-transport.ts:155-225`。
- 已落地：`McpHost` 管理 server config、连接状态、工具注册/注销、失败隔离和 runtime event。证据：`src/main/infrastructure/mcp/host.ts:26-38`、`src/main/infrastructure/mcp/host.ts:40-83`、`src/main/infrastructure/mcp/host.ts:148-174`、`src/main/infrastructure/mcp/host.ts:185-237`。
- 未落地：本项目 MCP transport 只支持 `stdio`，shared contract 的 transport enum 只有 `["stdio"]`。证据：`src/shared/agent-contracts.ts:348-349`。
- 未落地：HTTP/Streamable HTTP、legacy SSE、OAuth/auth diagnostic、schema cache、lazy/background placeholder、prompts/resources surface 在当前 MCP infrastructure 中未见实现；`McpClient` 注释明确 prompts/resources/roots/sampling 不在第一版。证据：`src/main/infrastructure/mcp/client.ts:30-34`。

### 4.2 `src/main/ipc/mcp-handlers.ts`：已落地（tools/status IPC）

- 已落地：MCP IPC handlers 覆盖 list servers、connect、disconnect、list tools、refresh tools，并全部返回 `ok/err` envelope 与 MCP error codes。证据：`src/main/ipc/mcp-handlers.ts:1-18`、`src/main/ipc/mcp-handlers.ts:19-63`、`src/shared/ipc-errors.ts:14-18`。
- 已落地：handler 对 request object、serverId 和可选 serverId 做解析，NUL 字符会被拒绝。证据：`src/main/ipc/mcp-handlers.ts:65-112`。

### 4.3 `src/main/index.ts`：已落地（组合根接线）

- 已落地：main 组合根创建 `InMemoryToolRegistry` 和 `McpHost`，并把同一个 registry 注入 `AgentRuntime`。证据：`src/main/index.ts:48-62`。
- 已落地：启动时读取 runtime preferences，`mcpHost.configure(preferences.mcpServers)` 后后台 `connectEnabled()`；runtime preferences update 后重新 configure 并 connect enabled。证据：`src/main/index.ts:192-198`、`src/main/index.ts:212-217`。
- 已落地：main 注册 MCP IPC handlers，并在 before-quit 关闭 MCP host。证据：`src/main/index.ts:200-209`、`src/main/index.ts:226-228`。

### 4.4 `src/shared/agent-contracts.ts`：部分落地

- 已落地：定义 McpServerConfig、McpToolInfo、McpServerStatusRecord、MCP status/event/request/response 类型。证据：`src/shared/agent-contracts.ts:348-396`、`src/shared/agent-contracts.ts:909-925`、`src/shared/agent-contracts.ts:1183-1212`。
- 已落地：`RuntimePreferences` 包含 `mcpServers`，默认值为空数组。证据：`src/shared/agent-contracts.ts:411-422`、`src/shared/agent-contracts.ts:536-545`。
- 已落地：runtime event union 和 kind list 已包含 `mcp_server_connection` 与 `mcp_tool_list_changed`，事件 guard 做字段校验。证据：`src/shared/agent-contracts.ts:962-989`、`src/shared/agent-contracts.ts:1358-1378`。
- 部分落地：permission rule tool enum 已包含 `"mcp"`，但文档 `docs/data-model.md` 仍写 `command | write`，与当前 shared contract 不一致。证据：`src/shared/agent-contracts.ts:398-399`、`docs/data-model.md:555-565`。

### 4.5 `src/shared/ipc.ts`：已落地

- 已落地：定义 MCP servers/tools channels，并加入 `RENDERER_TO_MAIN_CHANNELS`。证据：`src/shared/ipc.ts:63-68`、`src/shared/ipc.ts:70-113`。

### 4.6 `src/preload/index.ts` 与 `src/renderer/src/global.d.ts`：已落地

- 已落地：preload import MCP request/response 类型和 channel 常量。证据：`src/preload/index.ts:14-20`、`src/preload/index.ts:91-95`。
- 已落地：preload 暴露 `agentApi.mcp.listServers/connect/disconnect/listTools/refreshTools`。证据：`src/preload/index.ts:244-274`、`src/preload/index.ts:393-407`。
- 已落地：renderer global type 通过 `AgentDesktopApi` 继承 preload 暴露面。证据：`src/renderer/src/global.d.ts:1-7`、`src/preload/index.ts:409-411`。

### 4.7 `src/main/application/agent-runtime.ts`：部分落地

- 已落地：runtime 把 `mcp__` 前缀工具只暴露给 code thread，write thread 默认不暴露。证据：`src/main/application/agent-runtime.ts:193-200`、`src/main/application/agent-runtime.ts:1188-1201`。
- 已落地：MCP tool 注册为 `AgentTool` 后复用现有 tool catalog、approval/sandbox/permission policy 路径；runtime 对 readOnly metadata 直接 allow，非 readOnly 继续经过 sandbox、approvalPolicy、permissionRules 和 destructive metadata 判断。证据：`src/main/infrastructure/mcp/host.ts:202-237`、`src/main/application/agent-runtime.ts:1204-1244`。
- 未落地：runtime 未见对 MCP prompts/resources 的 slash 或 @ref 处理；本项目 MCP client 也明确未实现 prompts/resources。证据：`src/main/infrastructure/mcp/client.ts:30-34`。

### 4.8 `src/main/application/permission-policy.ts`：部分落地

- 已落地：permission evaluator 可把 `mcp__server__tool` 转为 `{ tool: "mcp", value: "server/tool" }`，用于 per-call 规则匹配。证据：`src/main/application/permission-policy.ts:66-96`。
- 已落地：权限规则优先级 deny > ask > allow，由纯函数实现。证据：`src/main/application/permission-policy.ts:8-12`、`src/main/application/permission-policy.ts:37-64`。
- 部分落地：注释仍称规则只 refine command/write calls，但代码实际也处理 mcp。证据：`src/main/application/agent-runtime.ts:1230-1238`、`src/main/application/permission-policy.ts:75-96`。

### 4.9 `src/main/persistence/`：已落地（配置持久化），但无 host cache/stats

- 已落地：runtime preferences schema parse/normalize/merge/clone 都包含 `mcpServers`。证据：`src/main/persistence/runtime-preferences-schema.ts:78-80`、`src/main/persistence/runtime-preferences-schema.ts:87-106`、`src/main/persistence/runtime-preferences-schema.ts:137-155`。
- 已落地：`parseMcpServerConfigs()` 校验数组、唯一 id/name、transport、command、createdAt/updatedAt、args/env/cwd/enabled/readOnlyTools。证据：`src/main/persistence/runtime-preferences-schema.ts:412-455`。
- 未落地：未见 Reasonix 式 MCP schema cache、startup stats、lazy demote 持久化；本项目相关持久化仅覆盖配置。证据：`src/main/persistence/runtime-preferences-schema.ts:412-464` 与 Reasonix cache/stats 机制对比：`docs/external-references/Reasonix/internal/plugin/cache.go:1-9`、`docs/external-references/Reasonix/internal/plugin/stats.go:1-10`。

### 4.10 `src/renderer/src/ui/`：部分落地

- 已落地：设置页工具分类包含 `mcpServers`。证据：`src/renderer/src/ui/SettingsView.tsx:120-132`。
- 已落地：设置页支持新增、更新、删除 MCP server config，连接、断开、刷新 tools 会调用 `window.agentApi.mcp.*`。证据：`src/renderer/src/ui/SettingsView.tsx:588-652`。
- 已落地：设置页 UI 展示 MCP server name/command/args/cwd/readOnlyTools/env，并提供 connect/disconnect/refresh/delete/add 操作。证据：`src/renderer/src/ui/SettingsView.tsx:1903-2041`。
- 已落地：zh-CN i18n 包含 MCP servers 与 MCP actions 文案。证据：`src/renderer/src/i18n/locales/zh-CN/translation.json:344-345`、`src/renderer/src/i18n/locales/zh-CN/translation.json:467-491`。
- 部分落地：英文 i18n 搜索未命中 MCP servers/actions 文案；`settings-search.ts` 已加入 mcpServers 搜索 key，但英文资源中对应 key 未命中。证据：`src/renderer/src/ui/components/settings/settings-search.ts:134-144`、`src/renderer/src/i18n/locales/en/translation.json:511-522`。
- 未落地：renderer 侧未见对 `mcp_server_connection` / `mcp_tool_list_changed` 的消费，除 SettingsView 手动按钮外没有状态面板刷新证据。证据：项目内搜索只命中 shared/main SSE 转发和 SettingsView API 调用，`src/main/ipc/sse-handlers.ts:110-117`、`src/renderer/src/ui/SettingsView.tsx:619-652`。

### 4.11 `tests/main/{ipc,infrastructure}/mcp-*`：未落地/未发现

- 未落地/未发现：`tests/main/ipc` 与 `tests/main/infrastructure` 下未发现 `mcp-*` 测试文件。证据：当前只读搜索 `find tests/main/ipc tests/main/infrastructure -maxdepth 2 -type f -name 'mcp-*'` 无输出。
- 风险含义：当前 MCP host 的 stdio handshake、失败隔离、tools/list changed refresh、IPC request validation 与 permission mcp pattern 需要阶段 2 优先补测试。该风险由“实现文件存在但 mcp-* 测试未发现”推导，证据见 `src/main/infrastructure/mcp/host.ts:148-174`、`src/main/ipc/mcp-handlers.ts:19-63` 以及上一条测试搜索。

## 5. 阶段 2 可消费的设计要点

1. 最小可交付不要越过 tools-only 边界。
   本项目当前 MCP host 已明确 tools-only，且已有 stdio transport、McpClient、McpHost、IPC、preferences 和 SettingsView 基础。阶段 2 如果继续实现，应先补齐 tests 与文档一致性，再考虑 HTTP/prompts/resources。证据：`src/main/infrastructure/mcp/client.ts:30-34`、`src/main/infrastructure/mcp/host.ts:26-38`、`src/main/ipc/mcp-handlers.ts:19-63`。

2. Host 应保持失败隔离和动态 registry 边界。
   Reasonix `StartAvailable()` 的核心是不让坏 server 阻塞好 server；本项目 `McpHost.connectEnabled()` 已逐 server catch 并记录 failed status。证据：`docs/external-references/Reasonix/internal/plugin/plugin.go:191-202`、`src/main/infrastructure/mcp/host.ts:68-83`、`src/main/infrastructure/mcp/host.ts:239-251`。

3. MCP tool 命名空间是后续 permission/UI/registry 的共同契约。
   Reasonix 与本项目都使用 `mcp__<server>__<tool>`；本项目 permission rule 进一步把它映射为 `server/tool`。证据：`docs/external-references/Reasonix/internal/plugin/plugin.go:840-850`、`src/main/infrastructure/mcp/client.ts:142-149`、`src/main/application/permission-policy.ts:90-96`。

4. readOnlyHint 不能默认信任缺失值。
   Reasonix 规定远端工具默认非 readOnly，只有 MCP readOnlyHint 或可信 Spec override 才进入 reader-default；本项目也将 annotations.readOnlyHint 与 config.readOnlyTools 合并。证据：`docs/external-references/Reasonix/docs/SPEC.md:142-145`、`src/main/infrastructure/mcp/protocol.ts:120-127`、`src/main/infrastructure/mcp/client.ts:82-86`。

5. 需要区分“状态事件已转发”和“UI 已消费”。
   本项目 SSE handler 已全局转发 MCP connection/tool list events，但 renderer 搜索未发现消费这些事件的 UI 状态更新。证据：`src/main/ipc/sse-handlers.ts:100-117`、`src/shared/agent-contracts.ts:909-925`、`src/renderer/src/ui/SettingsView.tsx:619-652`。

6. 当前文档需要同步修正，但本阶段不改。
   shared contract 已包含 `mcp` permission rule tool，docs/data-model 仍写 `command | write`；docs/开发路线图仍有“未发现当前实现”的旧描述。证据：`src/shared/agent-contracts.ts:398-399`、`docs/data-model.md:555-565`、`docs/开发路线图.md:133-187`。

## 6. 自查清单

- [x] 本次改动只写入 `docs/learning/mcp-plugin-host-learning.md`。
- [x] 未 import、link、copy 参考源码；本文只有机制总结和路径行号证据。
- [x] 未改 `src/`、`tests/`、配置文件或 `docs/external-references/`。
- [x] 未写代码或伪代码；未复制超过 10 行代码片段。
- [x] 每条事实性结论均附带路径+行号证据，无法证明的条目明确标注“未发现”或“推导”。
- [x] 本阶段为文档学习任务，未运行 `npm run typecheck`、`npm run test`、`npm run build`；原因是未修改代码，验证以文档范围、证据完整性和禁止项检查为主。

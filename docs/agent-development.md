# Agent 开发维护指南

## 文档定位

本文是 Agent 相关开发的维护入口，用来说明“改哪里、同步哪份文档、怎么验证”。它不再承担逐条变更记录、临时任务清单或规则副本职责。

不要在本文追加日常流水账。历史追踪使用 Git 记录、OpenSpec change、测试用例和对应领域文档。

## 先读什么

非平凡改动开始前，按任务类型读取：

- 通用规则：`AGENTS.md`。
- 项目地图和模块入口：`docs/project-map.md`。
- 整体架构图：`docs/architecture.md`。
- turn 生命周期、工具循环、approval、中断、事件流：`docs/runtime-flow.md`。
- IPC、preload API、错误码：`docs/ipc-contracts.md`。
- shared contract、JSONL、附件、模型配置、runtime preferences、checkpoint、MCP cache：`docs/data-model.md`。
- UI token、布局、组件模式：`docs/ui-design.md` 和 `docs/ui-layout-reference.md`。

只把 `src/`、`tests/`、`docs/` 中的项目文档和根目录构建配置作为项目实现依据。`docs/external-references/` 只读参考，不属于普通维护范围。只有当任务明确属于 OpenSpec change 且仓库中存在对应目录时，才把 `openspec/changes/<change-id>/` 纳入本次依据。

## 当前实现快照

当前项目是 Electron + Vite + React + TypeScript 的桌面 Agent Workbench。主路径是：

```text
renderer React
  -> window.agentApi
  -> preload contextBridge
  -> ipcMain handlers
  -> AgentRuntime / stores / event bus / tool registry
  -> LlmWorkerPool
  -> worker_threads
  -> MiniMaxGateway
  -> provider HTTP API
```

核心边界：

- `src/main/application/agent-runtime.ts` 是唯一 Agent runtime 入口。
- `src/main/index.ts` 是 main process 组合根。
- `src/preload/index.ts` 只暴露 `window.agentApi`。
- `src/shared/agent-contracts.ts` 是跨进程契约统一出口；模型配置与基础 guard 可拆到 `src/shared/model-config-contracts.ts`、`src/shared/contract-primitives.ts` 后再 re-export。
- `src/renderer/src/ui/store/WorkbenchContext.tsx` 是 renderer 状态中心。
- `src/main/application/tool-catalog.ts` 负责当前 turn 的工具目录过滤。
- `src/main/application/tool-policy.ts` 负责工具审批、拒绝和 permission rule 决策。
- `src/main/application/approval-coordinator.ts` 负责 pending approval 的内存状态、timeline item 和 live event。
- `src/main/application/context-compaction.ts` 负责模型请求前的上下文预算处理。
- `src/renderer/src/ui/hooks/` 放置 Workbench 局部交互 hooks，例如 pending approval 提交状态。

旧单次运行入口、旧响应 trace 契约和旧编排器已经下线。新增 Agent 能力必须接入当前多 turn runtime，不要恢复旧路径。

## 文档归属

修改后只同步相关权威文档，不要把所有细节都堆回本文。

| 变更类型 | 必须同步 |
| --- | --- |
| 模块边界、入口文件、测试地图、阅读顺序 | `docs/project-map.md`，必要时同步 `docs/architecture.md` |
| Runtime 状态机、工具循环、approval、中断、worker stream、runtime event | `docs/runtime-flow.md` |
| IPC channel、request/response、preload API、handler 错误码 | `docs/ipc-contracts.md` |
| Thread/Turn/Item/RuntimeEvent、附件、模型配置、runtime preferences、checkpoint、MCP cache、JSONL、迁移规则 | `docs/data-model.md` |
| UI token、布局语法、主题、组件模式 | `docs/ui-design.md` |
| 页面结构、组件布局、交互状态归属 | `docs/ui-layout-reference.md` |
| 开发流程、文档归属、跨模块维护策略变化 | `docs/agent-development.md` |

## 开发维护原则

- 先确认现有定义、调用链和测试，再改实现。
- 复用当前模块边界；不要为单次调用新增抽象层。
- 共享字段、IPC 契约和持久化格式变更必须同步 main、preload、renderer、tests 和对应文档。
- 工具实现应依赖最窄的 capability context；不要绕过 `ToolRegistry`、`ToolCatalogService`、`ToolPolicyService` 或 approval gate。
- Renderer 只能通过 `window.agentApi` 和 `src/shared/` 交互，不直接 import `src/main/`。
- 失败路径必须可追踪。IPC 返回 `IpcResult<T>`，工具失败写入可见 `ToolItem` 或 runtime event。
- 不在代码、测试、文档或提交中写入真实 API key。

## 变更记录策略

本文不维护“已完成内容”和逐日 changelog。以下位置才是历史与验收依据：

- Git commit / diff：记录真实代码和文档变更。
- OpenSpec change：仅在仓库实际存在对应目录时，作为较大能力的 proposal、design、tasks 和 specs 记录。
- `tests/`：固化行为、边界和回归风险。
- 领域文档：记录当前事实，不记录过期过程。

只有当开发维护流程本身变化，或新增一个长期维护者必须知道的跨模块边界时，才更新本文。

## 验证要求

代码改动默认运行：

```bash
npm run typecheck
npm run test
npm run build
```

文档-only 改动至少执行：

```bash
git diff --check -- <changed-docs>
```

并确认新增引用的路径存在。未运行构建或测试时，在交付说明中写明原因。

## 清理标准

清理文档时优先删除：

- 已被 `AGENTS.md`、`CLAUDE.md` 或领域文档覆盖的重复规则。
- 只描述历史过程、但不影响当前维护判断的流水账。
- 指向不存在路径、旧入口、旧 channel、旧字段或旧工具的说明。
- “后续可能”“临时方案”“待补充”但没有 owner、入口或验收标准的内容。

保留文档时必须满足至少一项：

- 能帮助定位当前实现入口。
- 说明当前仍生效的不变量或安全边界。
- 规定修改某类能力时必须同步的契约、测试或文档。
- 提供可执行验证步骤。

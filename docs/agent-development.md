# Agent 开发维护文档

## 文档目的

本文用于记录并维护本仓库 Agent 底层框架的开发内容、架构决策和后续演进事项。凡是修改 Agent 运行框架、LLM 接入、工具机制、IPC、桌面 UI 或国际化能力，都必须同步更新本文。

## 当前开发状态

当前项目已搭建 Electron、Vite、React、TypeScript 桌面应用骨架，用于运行 Agent 框架。核心架构采用“金字塔分层 + 三角循环”：

- 金字塔分层：`domain`、`core`、`application`、`infrastructure`、`preload`、`renderer`。
- 三角循环：`observe` 观察任务输入，`reason` 调用 LLM 推理，`act` 执行工具或完成行动。
- 模块交互：模块间通过 `domain/agent/types.ts` 和 `domain/agent/ports.ts` 中的接口契约交互。

## 已完成内容

- 建立 Electron 桌面应用入口：`src/main/index.ts`。
- 建立安全预加载桥接：`src/preload/index.ts`。
- 建立共享 IPC 与 Agent 请求/响应契约：`src/shared/`。
- 建立 Agent 领域类型和端口接口：`src/main/domain/agent/`。
- 建立三角循环追踪机制：`src/main/core/triangle-loop.ts`。
- 建立 Agent 编排器：`src/main/application/agent-runner.ts`。
- 建立工具注册机制和 `echo` 验证工具：`src/main/application/tools/`。
- 建立 MiniMax OpenAI/Anthropic 兼容协议适配：`src/main/infrastructure/minimax/`。
- 建立 React 桌面控制台 UI：`src/renderer/src/ui/`。
- 建立中英文国际化资源和语言切换能力：`src/renderer/src/i18n/`、`src/shared/locale.ts`。

## 架构决策

1. 领域层不依赖 MiniMax、Electron、React 或 HTTP 响应结构。
2. LLM 接入统一通过 `LlmGateway`，供应商协议差异只存在于 `infrastructure`。
3. Agent 编排器只处理运行流程，不直接拼接供应商请求体。
4. 工具能力通过 `ToolRegistry` 接口注册和执行，后续工具不得绕过注册机制。
5. 渲染层只通过 preload 暴露的安全 API 调用主进程，不直接访问 Node 能力。
6. 界面语言切换属于渲染层展示机制，语言资源集中维护在 `src/renderer/src/i18n/`，可支持语言由 `src/shared/locale.ts` 统一定义。

## 后续待办

- 为 Agent 循环、MiniMax 响应归一化、工具调用和 IPC 契约补充自动化测试。
- 增加工具调用多轮历史的完整保留策略。
- 增加 API Key 的本地安全存储或环境变量读取策略。
- 增加运行日志、错误详情和调试面板。
- 将主进程返回的运行轨迹标题、校验错误和执行错误升级为可本地化的错误码/消息码。
- 梳理打包发布流程。

## 维护要求

每次 Agent 相关开发完成后，必须更新以下内容：

- 如果新增或调整模块，更新“已完成内容”和对应路径。
- 如果改变分层、接口、循环流程或供应商接入方式，更新“架构决策”。
- 如果发现未完成事项，更新“后续待办”。
- 如果修复重要问题，在“变更记录”追加日期、摘要和验证方式。

## 变更记录

### 2026-06-07

- 初始化 Agent 桌面框架开发维护文档。
- 记录当前分层架构、三角循环、MiniMax 双协议接入、工具注册、IPC、React UI 和国际化能力。
- 验证方式：文档检查；代码侧此前已通过 `npm run typecheck` 和 `npm run build`。
- 落地渲染层中英文界面语言切换：新增 `src/shared/locale.ts`、`src/renderer/src/i18n/` 资源与初始化，并将 React 控制台静态文案迁移到 `react-i18next`。
- 验证方式：`npm run typecheck`、`npm run build`。

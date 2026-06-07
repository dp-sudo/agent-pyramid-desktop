# Repository Guidelines

## 项目结构与模块组织

本仓库是基于 Electron、Vite、React、TypeScript 的桌面 Agent 运行框架。

- `src/main/domain/agent/`：领域类型、端口接口和核心契约。
- `src/main/core/`：框架机制，例如三角循环追踪。
- `src/main/application/`：Agent 编排逻辑和工具注册。
- `src/main/infrastructure/minimax/`：MiniMax OpenAI/Anthropic 兼容协议适配。
- `src/preload/`：Electron 安全桥接层。
- `src/renderer/`：React 桌面界面。
- `src/shared/`：主进程、预加载和渲染层共享的类型与常量。
- `docs/minimax/`：MiniMax 本地文档，只作为接口依据，不写入运行逻辑。

国际化资源位于 `src/renderer/src/i18n/locales/<locale>/`，新增语言时同步更新 `src/shared/locale.ts`。

Agent 开发维护文档位于 `docs/agent-development.md`。凡是修改 Agent 运行框架、LLM 接入、工具机制、IPC、桌面 UI 或国际化能力，都必须同步更新该文档。

## 架构与接口化规则

必须保持“逻辑和机制拆成代码文件”的边界。机制放在 `core`，业务编排放在 `application`，供应商接入放在 `infrastructure`，UI 放在 `renderer`。

模块间只能通过明确接口交互。优先在 `domain/agent/types.ts` 和 `domain/agent/ports.ts` 定义契约，再由应用层或基础设施层实现。禁止让领域层直接依赖 MiniMax、Electron、React 或具体 HTTP 响应结构。

新增功能时先判断职责边界：如果是 Agent 循环机制，放入 `core`；如果是运行流程，放入 `application`；如果是外部服务，放入 `infrastructure`；如果是展示交互，放入 `renderer`。

## 构建、测试与开发命令

- `npm run dev`：启动 Electron 和 Vite 渲染开发服务。
- `npm run build`：构建 main、preload、renderer 到 `out/`。
- `npm run typecheck`：运行 TypeScript 类型检查。
- `npm run preview`：预览构建后的 Electron 应用。

首次克隆后运行 `npm install`。如果 Electron 下载失败，可使用镜像：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npx install-electron --no
```

## 编码风格与命名约定

使用严格 TypeScript。避免 `any`、`@ts-ignore` 和吞掉错误。缩进使用两个空格，字符串使用双引号。React 组件和类使用 `PascalCase`，函数与变量使用 `camelCase`，常量仅在真正跨模块固定值时使用 `UPPER_SNAKE_CASE`。

## 测试指南

当前尚未配置测试框架。每次改动至少运行：

```bash
npm run typecheck
npm run build
```

后续新增测试时，使用 `*.test.ts` 或 `*.test.tsx`，优先覆盖 Agent 循环、MiniMax 响应归一化、工具调用和 IPC 契约。

## 提交与 Pull Request

当前没有可参考的 Git 提交历史。提交信息建议使用 Conventional Commits，例如 `feat: add minimax gateway`、`fix: validate max tokens`。

PR 需说明变更目的、影响模块、验证命令。涉及 UI 时附截图；涉及接口或协议时注明依据的 `docs/minimax/` 文档。

涉及 Agent 框架能力的 PR 必须说明是否已更新 `docs/agent-development.md`；如果无需更新，需写明原因。

## 安全与配置

不要提交 API Key、密钥或本地敏感配置。MiniMax 凭据只允许通过运行时输入或环境变量提供。保持 Electron 安全设置：`contextIsolation: true`、`nodeIntegration: false`。

# 前端全面审计 — 范围与方法

> 本文档定义**只读审计阶段**的范围、方法与产出。审计阶段不改任何代码、配置或测试。
> 用户在审阅审计报告后，再决定启动哪些子项目（每个子项目走独立的 spec → plan → 实现）。

## 背景与决策

- 任务性质：**全面整改**（逻辑缺陷排查 + 视觉一致性打磨）。
- 仓库现状：存在一组未提交的渲染端改动（RightInspector 错误处理、Settings、i18n、styles、多个 renderer 测试），看起来是已开始的一轮优化。
- 处理方式：**在现有改动基础上继续**，把这组改动作为基线纳入审计。
- 交付节奏：**先完整审计再动手**。
- 审计深度：**深度源码审计**（逐区域读源码 + 交叉核对测试 + 跨集群问题识别）。
- 衔接：**先只出审计报告**；用户确认问题清单与优先级后再启动具体子项目。

## 审计范围

前端全部源码与渲染端测试，按 13 个方面组织，归并为 5 个集群：

| 集群 | 覆盖的方面（用户原始列表） | 涉及核心文件 |
| --- | --- | --- |
| **A. 输出渲染** | 模型输出渲染与内容排序；模型推理内容折叠；代码块折叠逻辑 | `AssistantMarkdown.tsx`、`ChatBlock.tsx`、`MessageTimeline.tsx`、`timeline-model.ts` |
| **B. 工作区隔离与写作** | 工作区隔离机制；写作工作区体验 | `Workbench.tsx`、`WriteWorkspaceView.tsx`、`WriteEditorPanel.tsx`、`WriteAssistantPanel.tsx`、`workbench-thread-service.ts`、`workbench-runtime-events.ts` |
| **C. 设置与控制逻辑** | 功能设置控制逻辑 | `SettingsView.tsx`、`Settings*Panel.tsx`、`settings-*-model.ts`、`preferences.ts`、`store/WorkbenchContext.tsx` |
| **D. 布局与视觉风格** | 界面布局；界面色调与视觉风格 | `styles/tokens.css`、`styles/shell.css`、各 `*-stage` 组件、`usePanelResizer.ts` |
| **E. 交互与基础组件** | UI 细节；交互逻辑细节；对话框与渲染体验 | `composer/*`、`inspector/RightInspector.tsx`、`sidebar/Sidebar.tsx`、`topbar/*`、`primitives/*`、`chat/PendingApprovalPanel.tsx`、`WorkbenchErrorToast.tsx` |

边界说明：

- D（视觉）与 E（交互）是横切集群，几乎影响所有组件。审计时按"组件 × 方面"交叉记录，并在报告里单独列出跨集群问题。
- 审计**只读**：不运行会改变状态的命令，不修改构建/测试/运行时配置。
- 审计**不**纳入 `docs/external-references/`（AGENTS.md 第 3 节硬性约束）。

## 审计方法

1. **源码通读**：按集群通读每个文件，理解状态所有权、数据流、事件流与生命周期。
2. **测试交叉核对**：对每个方面，核对 26 个渲染端测试文件，识别未测试或弱测试路径（重点：状态不同步、隔离污染、错误吞掉、取消/竞态）。
3. **三路由隔离审计**：对 code / write / settings 三条路由，专项检查工作区隔离机制（`workspaceRoot`、`threads`、`composer`、`activeThread`、`leftSidebarWidth` 的共享与隔离边界）。
4. **未提交改动核对**：审计前先核实现有未提交改动的自洽性，作为基线纳入。
5. **跨集群问题识别**：单独标记"一个根因同时影响 A 和 D"这类问题，避免修复时割裂。

## 每条发现的记录格式

```text
[集群 / 方面] 标题
- 位置: <file:line>
- 现象: 用户可观察到的表现
- 根因: 触发条件与代码原因
- 影响: 状态不同步 / 隔离污染 / 体验割裂 / 视觉不一致 / 错误吞掉 / 半成品残留 …
- 建议修复方向: 方向性描述（不写具体代码）
- 优先级: P0（状态/数据正确性）/ P1（体验）/ P2（视觉打磨）
- 跨集群标记: 仅当问题同时属于多个集群时标注
```

## 产出

单一文件：`docs/superpowers/specs/2026-06-17-frontend-audit.md`

结构：

1. **基线核对**：未提交改动自洽性结论 + 三路由隔离现状概览。
2. **发现清单**：按集群分组，集群内按优先级排序，每条用上述格式。
3. **跨集群问题**：单独一节。
4. **优先级汇总**：P0/P1/P2 各多少条，按集群分布。
5. **子项目候选**：基于发现清单，提出若干可独立交付的子项目候选（不展开实现，留给用户选择）。

## 不做（审计阶段）

- 不改任何源码、样式、配置、测试。
- 不运行 `npm run build` / `npm run test`（除非需要确认未提交基线的状态，且仅在用户同意下）。
- 不创建 OpenSpec change 目录（除非用户明确要求启动 OpenSpec 工作流）。
- 不引用或纳入 `docs/external-references/` 下任何文件。

## 验证

- 审计报告完成后做 spec self-review（占位扫描、内部一致性、范围检查、歧义检查）。
- 提交审计报告到 git。
- 请用户审阅审计报告，确认问题清单与优先级后再决定启动哪些子项目。

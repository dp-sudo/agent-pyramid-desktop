# Write Workbench Audit Archive

本文是写作工作台早期审计与修复计划的归档摘要，不再作为当前 UI、IPC、数据模型或 runtime 行为的权威来源。

当前事实请优先查看：

- `docs/ui-layout-reference.md`
- `docs/ui-design.md`
- `docs/runtime-flow.md`
- `docs/ipc-contracts.md`
- `docs/data-model.md`
- `src/renderer/src/ui/components/write/`
- `src/renderer/src/ui/components/workbench/WriteWorkbenchStage.tsx`

## 历史范围

原审计覆盖写作工作台的布局、状态反馈、Markdown 预览、助手时间线、审批展示、工具隔离、补全位置、选区上下文和侧栏调宽等问题。

这些问题已经按 P0 到 P3 分批处理。保留本文只为解释相关改动的历史背景，避免后续维护者误把旧缺陷清单当作当前 backlog。

## 已完成主题

| 主题 | 当前归属 |
| --- | --- |
| 写作路线审批面板、差异预览、allow/deny 提交中状态 | `docs/ui-layout-reference.md`、`docs/runtime-flow.md` |
| 写作助手按 turn 分组展示推理、工具、审批、计划、系统提示和最终回复 | `docs/ui-design.md`、`docs/ui-layout-reference.md` |
| 写作助手滚动只在接近底部时自动跟随 | `docs/ui-design.md`、`docs/ui-layout-reference.md` |
| 保存按钮禁用态和长错误状态栏 | `docs/ui-layout-reference.md` |
| Markdown 源码/预览分栏和安全 Markdown 渲染 | `docs/ui-design.md`、`docs/ui-layout-reference.md` |
| 补全贴近光标并支持 Tab 接受、Escape 取消 | `docs/ui-layout-reference.md` |
| 显式选区或有界光标附近片段作为写作助手上下文 | `docs/ui-layout-reference.md` |
| 写作侧栏鼠标/键盘调宽、双击恢复默认宽度 | `docs/ui-layout-reference.md` |

## 维护规则

- 不要在本文追加新的写作工作台需求或 bug。
- 新需求应进入当前权威文档、OpenSpec change 或 issue/任务系统。
- 如果本文再次与当前实现冲突，优先删除过期段落，而不是把旧计划扩写成新的维护文档。

## 验证入口

写作工作台相关代码改动通常至少检查：

```bash
npm run typecheck
npm run test
npm run build
```

需要聚焦测试时，可优先查看 `tests/renderer/write-workspace-view.test.ts`、`tests/renderer/workbench-stage.test.tsx`、`tests/renderer/message-timeline.test.ts` 和相关 IPC/runtime 测试。

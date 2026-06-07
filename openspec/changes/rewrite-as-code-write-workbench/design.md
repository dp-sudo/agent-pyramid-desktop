## Context

**当前状态**（2026-06-07）：

- 仓库 F:\Agent 已搭 Electron + Vite + React + TS 桌面骨架。`docs/agent-development.md` 记录了"分层架构 + 多 turn runtime"的架构决策。
- 主进程已实现：`domain/agent/{ports,types}.ts` 端口契约、`application/agent-runtime.ts` 多 turn runtime、`application/tools/echo-tool.ts` 工具样例、`infrastructure/minimax/{gateway,types}.ts` LLM 网关。
- 共享层：`shared/agent-contracts.ts` 定义 thread / turn / item / runtime event 等多 turn 契约，`shared/ipc.ts` 定义 renderer 可调用 channel 清单。
- 预加载：`preload/index.ts` 暴露 `window.agentApi.{threads, turns, sse, approvals, goals, attachments, usage, workspace, write, modelConfig}`。
- 渲染端：HEAD 中 `App.tsx` 与 `styles.css` 已删除（git 状态 `D`），`main.tsx` 仍 import 两者，导致 `npm run build` 失败。`ui/components/{composer,topbar,sidebar,settings,main,icons}` 全是空目录。
- i18n：`i18n/{en,zh-CN}/translation.json` 完整，含 12 个命名空间。
- 持久化：无。
- 主题/设计令牌：无。

**目标用户**：桌面 Agent 框架开发者与终端用户。需要支持长会话（多 turn）、工具调用、Markdown 写作辅助。

**约束**：
- 不破坏 `domain/agent/ports.ts` 契约。
- 不动 MiniMax 网关。
- 不引入 Tailwind / Zustand / React Router。
- 不删除现有 i18n 资源。

**参考**：DeepSeek-GUI-master 的 `DESIGN.md`（YAML frontmatter 风格的设计权威）、`AppShell.tsx`（路由入口）、`Workbench.tsx`（三段式布局）、`base-shell.css`（token 表）。

## Goals / Non-Goals

**Goals：**

- G1：把渲染端从"单回合控制台"升级为"会话式 workbench"，承载长会话状态。
- G2：扩协议支持多 turn、tool call、SSE 事件流、approval；旧 `agentApi.run()` 下线，运行入口统一为 turn API。
- G3：主进程内编排 + Node `worker_threads` 隔离 LLM 推理；推理失败不阻塞 UI。
- G4：JSONL + 索引持久化，支持 `fork` / `side` 会话族谱。
- G5：UI 三段式（Sidebar / Center / Right Inspector），覆盖 Code + Write 两个工作面。
- G6：设计令牌化（CSS 变量 + 文档），light/dark 双主题、`prefers-reduced-motion` 兜底、CJK 字体 fallback 链。
- G7：i18n 双语同步扩充，不删旧 key。

**Non-Goals：**

- N1：不做 plugins / schedule / Connect phone（IM 通道）三个工作面。留作后续 change。
- N2：不做运行时多实例或集群化。单一主进程 + 多个 worker。
- N3：不做 Auth（DeepSeek 有 bearer token，本项目假定本地运行）。
- N4：不做跨 thread 共享 memory。每 thread 独立。
- N5：不做 FIM 长文生成的复杂 RAG 召回；仅最简 BM25 关键词命中。
- N6：不做 skill marketplace / plugin system。

## Decisions

### D1：状态层用 React Context + useReducer，不引入 Zustand

**为什么**：本项目 `package.json` 未装 zustand；引入会破坏 §3.1 "能用现有库解决的不引入新依赖"。Context + useReducer 足够覆盖本项目状态规模（单 store 树深 3-4 层）。

**备选**：
- Zustand：selector 写法更优雅，但需新增依赖（拒绝）。
- Redux Toolkit：太重，本项目状态量不匹配（拒绝）。
- Recoil/Jotai：atom 模型更适合细粒度订阅，本项目无此需求（拒绝）。

### D2：路由用 `route` 字段条件渲染，不引入 React Router

**为什么**：DeepSeek 同样不使用 React Router（其 `Workbench.tsx` 用 `if (route === 'chat') ...` 链式判断）。本项目路由集合 ≤ 4 个（workbench/settings/initial-setup/404），条件渲染可读性足够。

**备选**：
- React Router 6：会引入 history API + 嵌套路由，本项目无 URL 同步需求（拒绝）。
- Hash 路由自实现：复杂度不亚于 React Router（拒绝）。

### D3：LLM 推理用 Node `worker_threads` 隔离

**为什么**：用户已选 "主进程内 + Web Worker 备选"。Node `worker_threads` 与浏览器 Web Worker 同源概念，零依赖。主进程只做编排（线程安全），推理（计算密集 + 第三方 SDK 抛异常）放 worker 隔离。

**关键点**：
- worker 文件 `src/main/infrastructure/llm-worker/worker.ts` 通过 `parentPort` 接收 `{ type: 'chat', request: ChatRequest }`，返回 `{ type: 'delta' | 'done' | 'error' }`。
- 主进程与 worker 通过 zod schema 校验消息（`src/shared/agent-contracts.ts` 内的 `ChatRequestSchema` / `ChatResponseSchema`）。
- 推理流式 delta 通过 worker `parentPort.postMessage` 推送，主进程 `worker.on('message')` 收后入 `event-bus`，再 `webContents.send` 推渲染端。

**备选**：
- 子进程 spawn：太重，IPC 开销大，不必要。
- 同步调用：不隔离，第三方 SDK 异常会拖死主进程（拒绝）。

### D4：持久化 JSONL + 索引（仿 DeepSeek）

**为什么**：DeepSeek 的 `{userData}/threads/{id}/{thread.json,messages.jsonl,events.jsonl}` 设计经过验证，支持 append-only + 原子索引。

**目录布局**：

```
{userData}/
  threads/
    index.json                    # 全部 thread 摘要（最近修改时间、title、relation）
    {threadId}/
      thread.json                 # ThreadRecord（原子写）
      messages.jsonl              # Item[] append-only
      events.jsonl                # RuntimeEvent[] append-only
```

**原子写**：写 `thread.json` 时先写 `{threadId}.json.tmp`，再 `rename` 到 `thread.json`。

**重放**：`messages.jsonl` / `events.jsonl` 读时按行解析，跳过畸形行（不抛错）。

**备选**：
- SQLite：能力过强，schema 演化是负担。
- LevelDB / LMDB：本项目无 KV 访问模式。
- electron-store：单文件 JSON，并发写不友好。

### D5：UI 三段式用 CSS Grid + Flex，不引入栅格库

**为什么**：DeepSeek 的 `Workbench.tsx` 用 `display: flex` + `style={{ width }}` 即可，本项目保持同样轻量。Sidebar / Right Inspector 宽度由 React state 控制，drag-resize 用原生 `onPointerDown` + `pointermove` 实现。

**备选**：
- react-resizable-panels：成熟但增加 30KB 依赖。
- 自实现：60 行代码可控。

### D6：样式用 CSS Modules + 全局 token CSS，命名向 `--ds-*` 靠拢

**为什么**：DeepSeek 已经在 CSS 中建立了 `--ds-*` 命名空间生态（见 `base-shell.css:5-92`），本项目沿用同一前缀便于以后跨项目检索与共享。**不**使用 Tailwind，因为本项目明确不引入。

**结构**：
- `src/renderer/src/ui/styles/tokens.css` —— 全局 CSS 变量（light/dark 双套）。
- `src/renderer/src/ui/styles/shell.css` —— 三段式布局（`.ds-workbench-shell`、`.ds-stage-inset` 等）。
- 各组件 `*.module.css` —— 组件级样式，引用 `--ds-*` 变量。

### D7：删除旧 `agentApi.run()` 兼容壳

**为什么**：项目当前主 UI 与 IPC 已迁移到多 turn runtime，继续保留旧单次运行入口会让跨进程契约、主进程组合根和测试存在第二套过期路径。

**实现**：删除 preload `run()`、旧 IPC channel、旧 shared 类型、旧适配器和旧测试；外部调用方改用 `threads.*` + `turns.start` + `sse.*`。

### D8：i18n 沿用 `react-i18next`，key 命名空间按域分

**为什么**：现有 i18n 已用 react-i18next，零增量。新增 key 全部以二级命名空间归类（`chat.threadList.*`、`write.composer.*`），便于本地化人员按域翻译。

### D9：设计权威文档新建 `docs/ui-design.md`

**为什么**：DeepSeek 的 `DESIGN.md` 是其设计变更的"唯一来源"。本项目之前没有对等文档，导致任何 UI 修改都"拍脑袋"。新建 `docs/ui-design.md`，frontmatter + 正文结构对齐 DeepSeek，确保以后改 UI 必须同步改文档。

## Risks / Trade-offs

- **[R1] 渲染端大替换可能让 `npm run build` 中间态失败** → 阶段 4 之前保留可解析的 `main.tsx`（用 `import { App }` 占位 + 空 `App` 函数），阶段 4 一气呵成替换为 `AppShell`。中途不 commit。
- **[R2] worker 与主进程的 schema 漂移** → 阶段 1 引入 zod，单测覆盖 100% schema 边界。
- **[R3] JSONL 重放一致性** → 阶段 2 用 vitest 写 fuzz 测试：随机注入畸形行后 `replay()` 应只丢该行、保留其他。
- **[R4] CSS 变量切换主题时的 FOUC** → `:root[data-theme]` 在 `<html>` 渲染前由 i18n init 同步设置（用 localStorage 同步读取）。
- **[R5] 旧 `run()` 兼容壳会让主进程多一条热路径** → 下线旧入口，避免恢复 `LegacyRunAdapter` 或旧 trace 数据形态。
- **[R6] Sidebar 拖拽改变宽度在窗口缩小时的边界** → `min-width: 180px` 硬下限 + `max-width: 420px` 硬上限（DeepSeek 同样做法）。
- **[R7] Write 模式的 inline completion 触发频率与 LLM 调用成本** → debounce 650ms + min accept score 0.52 + max 96 token（与 DeepSeek 一致）。
- **[R8] i18n key 在阶段拆分时漏翻译** → 阶段 5 之前 `translation.json` 必须每个 namespace 都有 `en + zh-CN` 同步，CI 加 lint 校验。

## Migration Plan

**部署**：
- 本项目是开发中的桌面 App，无生产用户。阶段 4 完成 = `npm run build` 绿灯 + 启动后能看到空三段式 = 即可视为可演示。
- 阶段 5 完成 = 完整 Code + Write 流程跑通 = 可进入 alpha 测试。

**回滚**：
- 阶段 1-3 任意阶段回滚 = `git restore` 即可，主进程 IPC 接口未对外暴露。
- 阶段 4 完成 = UI 已替换，git 回滚 `renderer/src/ui/**` 与 `main.tsx` 即可。
- 阶段 5 完成 = 数据 schema 已落地；回滚需保留 `{userData}/threads/` 不动，旧 schema 兼容。

**灰度**：
- 无用户级灰度，但开发者可在 feature flag `agent.runtime.worker_threads` 上关闭 worker，回到主进程同步推理（用于调试）。

## Open Questions

- Q1：tool registry 当前只有 `echo-tool`，阶段 5 是否需要新增 `read-file / write-file / bash` 三个最小工具以演示？默认：加，否则无 tool block 演示。
- Q2：Right Inspector 在 Code 模式默认开还是关？默认：关，用户主动展开。
- Q3：Write 模式是否需要"按文件组织 sidebar"？默认：先做"按时间排序的工作区列表"，文件树留作后续。
- Q4：是否需要做 Windows 自绘 title bar？默认：是（DeepSeek 做了，集成成本低）。
- Q5：是否暴露"导出 thread 为 JSON"功能？默认：否，JSONL 已可读，导出仅作为 debug 工具留 hook。

---
# DESIGN.md frontmatter — machine-readable design tokens for design agents.
# Values are extracted from src/renderer/src/ui/styles/tokens.css.
# Anything not in this block is editorial, not authoritative.

schema_version: 1
project: agent-pyramid-workbench
single_runtime: agent-runtime
themes: [light, dark]

# ---------- 1. Palette (raw hex from --ds-* tokens) ----------
palette:
  light:
    bg_main: "#f5f7fa"
    bg_sidebar: "#f4f7fb"
    bg_canvas: "#fbfcfe"
    surface_card: "rgba(255,255,255,0.9)"
    surface_elevated: "rgba(255,255,255,0.98)"
    surface_subtle: "#eef2f7"
    surface_hover: "rgba(15,23,42,0.055)"
    border: "rgba(15,23,42,0.12)"
    border_muted: "rgba(15,23,42,0.08)"
    border_strong: "rgba(15,23,42,0.18)"
    text: "#222222"
    text_muted: "#5f6878"
    text_faint: "#8a93a4"
    text_placeholder: "#949dad"
    accent: "#0088ff"
    accent_soft: "rgba(0,136,255,0.14)"
    focus_ring: "0 0 0 3px rgba(0,136,255,0.18)"
    bubble_user: "rgba(0,0,0,0.06)"
    bubble_user_fg: "#222222"
    success: "#128a4a"
    success_soft: "rgba(17,185,129,0.14)"
    danger: "#c92a2a"
    danger_soft: "rgba(239,68,68,0.12)"
    diff_added: "#128a4a"
    diff_added_soft: "rgba(18,138,74,0.10)"
    diff_removed: "#c92a2a"
    diff_removed_soft: "rgba(201,42,42,0.10)"
    skill: "#7c3aed"
    skill_soft: "rgba(124,58,237,0.12)"
    warning_soft: "rgba(245,158,11,0.14)"
    selection: "rgba(0,136,255,0.18)"
    scrollbar_thumb: "rgba(95,104,120,0.22)"
    scrollbar_thumb_hover: "rgba(95,104,120,0.32)"
  dark:
    bg_main: "#101010"
    bg_sidebar: "#141414"
    bg_canvas: "#181818"
    surface_card: "rgba(24,24,24,0.92)"
    surface_elevated: "#202020"
    surface_subtle: "#202020"
    surface_hover: "rgba(255,255,255,0.10)"
    border: "rgba(255,255,255,0.10)"
    border_muted: "rgba(255,255,255,0.10)"
    border_strong: "rgba(255,255,255,0.16)"
    text: "#ffffff"
    text_muted: "#c7c7c7"
    text_faint: "#858585"
    text_placeholder: "#7a7a7a"
    accent: "#339cff"
    accent_soft: "rgba(51,156,255,0.18)"
    focus_ring: "0 0 0 3px rgba(51,156,255,0.24)"
    bubble_user: "rgba(255,255,255,0.08)"
    bubble_user_fg: "#ffffff"
    success: "#40c977"
    success_soft: "rgba(64,201,119,0.18)"
    danger: "#fa423e"
    danger_soft: "rgba(250,66,62,0.18)"
    diff_added: "#40c977"
    diff_added_soft: "rgba(64,201,119,0.16)"
    diff_removed: "#fa423e"
    diff_removed_soft: "rgba(250,66,62,0.16)"
    skill: "#ad7bf9"
    skill_soft: "rgba(173,123,249,0.16)"
    warning_soft: "rgba(245,158,11,0.18)"
    selection: "rgba(51,156,255,0.24)"
    scrollbar_thumb: "rgba(170,170,170,0.28)"
    scrollbar_thumb_hover: "rgba(200,200,200,0.38)"

# ---------- 2. Typography ----------
typography:
  family:
    sans: "SF Pro Text, 'PingFang SC', 'Noto Sans SC', 'Helvetica Neue', Arial, sans-serif"
    display: "SF Pro Display, 'PingFang SC', 'Noto Sans SC', sans-serif"
    mono: "SF Mono, 'JetBrains Mono', 'IBM Plex Mono', monospace"
  size_scale_px: [11, 11.5, 13, 14, 15, 18, 24]
  size_rhythm:
    caption: 11
    label: 11.5
    body: 13
    body_lg: 14
    title: 15
    title_lg: 18
    display: 24
  weight_scale: [400, 500, 600, 700]
  motion:
    micro_ms: 140
    standard_ms: 150
    deep_ms: 300
    ease: ease

# ---------- 3. Spacing & sizing ----------
spacing:
  base_unit_px: 4
  card_padding:
    tight: "px-3 py-2"
    normal: "px-4 py-3"
  layout:
    left_sidebar_default_px: 268
    left_sidebar_min_px: 180
    left_sidebar_max_px: 420
    right_inspector_default_px: 360
    right_inspector_min_px: 280
    right_inspector_max_px: 760

# ---------- 4. Border radius ----------
radius:
  scale_px: [6, 8, 12, 14, 16, 22, 28, 9999]
  alias:
    sm: 6
    md: 8
    lg: 12
    xl: 14
    "2xl": 16
    "3xl": 22
    composer: 28
    pill: 9999
  usage:
    chip: pill
    card_default: lg
    dialog: "3xl"
    composer: composer
    inline_code: sm
    icon_only_button: md

# ---------- 5. Elevation ----------
elevation:
  light:
    card_soft: "0 10px 28px rgba(15,23,42,0.06)"
    card_strong: "0 14px 36px rgba(15,23,42,0.09)"
    panel: "0 16px 44px rgba(15,23,42,0.06)"
    shell: "0 12px 30px rgba(15,23,42,0.08)"
    composer: "0 18px 46px rgba(15,23,42,0.10), 0 5px 16px rgba(15,23,42,0.06)"
  dark:
    card_soft: "0 16px 42px rgba(0,0,0,0.22)"
    card_strong: "0 22px 56px rgba(0,0,0,0.30)"
    panel: "0 22px 58px rgba(0,0,0,0.35)"
    shell: "0 38px 96px rgba(0,0,0,0.55)"
    composer: "0 28px 78px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.06)"

# ---------- 6. Z-index ----------
z_index:
  base: 0
  sticky: 10
  divider: 20
  dropdown: 50
  modal: 100
  toast: 200

# ---------- 7. Window chrome ----------
window:
  app_region: drag
  no_drag_class: ds-no-drag
  macos_top_inset_px: 42
  platforms: [darwin, win32, linux]

# ---------- 8. Component patterns ----------
components:
  pill:
    base: "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[11.5px] font-medium bg-ds-card border-ds-border"
  pill_accent:
    base: "inline-flex items-center gap-1.5 rounded-full border-0 bg-ds-accent text-white px-2.5 py-1.5 text-[11.5px] font-medium"
  composer:
    base: "rounded-[28px] border border-ds-border-strong bg-ds-elevated shadow-composer"
  user_bubble:
    base: "rounded-xl bg-ds-bubble-user px-3 py-2 text-[13px] font-medium text-ds-bubble-user-fg"
  assistant_bubble:
    base: "rounded-xl border border-ds-border-muted bg-ds-card px-3 py-2 text-[13px] text-ds-text"
  approval_block:
    base: "rounded-md bg-ds-warning-soft border border-ds-border p-3"

# ---------- 9. Layout grammar ----------
grammar:
  shell: "flex row, three-pane"
  panes:
    - "Sidebar (left, drag-resizable, default 268px)"
    - "Center column (flex 1, contains Topbar + MessageTimeline + FloatingComposer)"
    - "Right Inspector (right, drag-resizable, default 360px, optional)"
  routes: [code, write, settings]
  state_store: React useReducer (no external dependency)
  local_preferences: "src/renderer/src/ui/preferences.ts stores basic settings for language/theme handoff, startup view, resizable widths, Inspector defaults, archived threads, workspace restore, and delete confirmation."

# ---------- 10. i18n ----------
i18n:
  locales: [en, zh-CN]
  default: zh-CN
  namespaces: [locales, usage, chat, write, threads, inspector, approvals, common, composer, settings, routes, empty]
  basic_settings_groups: [appearance, startup, session]

# ---------- 11. Don't (anti-patterns) ----------
dont:
  - "Add a second live agent runtime — the local AgentRuntime is the only one."
  - "Add a runtime switcher / connection status bar / runtime diagnostics dialog."
  - "Add a runtime / usage slash command that opens a runtime control panel."
  - "Add Tailwind / Zustand / React Router — this project uses CSS Modules + useReducer + route field."
  - "Add emoji in production copy or as functional UI affordance."
  - "Use a font outside the three declared families."
  - "Use a border radius smaller than 6px on a clickable surface."
---

# Agent Workbench — DESIGN.md

> 单一权威设计文档。所有屏幕、组件、视觉决策，从这里出。

## 0. How to read this file

- **YAML frontmatter** —— 机器可读的设计令牌。
- **Markdown body** —— 设计意图与"为什么"。

## 1. Project at a glance

Agent Workbench 是本仓库的桌面客户端。底座是 `AgentRuntime`（主进程内多 turn 编排器），通过 `window.agentApi` 暴露给渲染端。

Two workbenches plus settings:
- **Code**（默认）—— Sidebar 列出 thread、Center 渲染 MessageTimeline + FloatingComposer、Right Inspector 选 changes/todo/plan。
- **Write** —— 打开 workspace 后，左侧文件列表，中间 Markdown 编辑器 + 状态条，右侧 Write assistant 面板承载显式写作请求和 Write thread 回复。
- **Settings** —— two-level settings center: top category tabs, left
  sub-navigation for the active category, constrained detail column, card
  groups, row controls, secret input, immediate local preferences, and status
  feedback.
- **Workbench switch** —— the Code sidebar footer exposes a compact Code/Write
  switch that calls the existing `setRoute("code" | "write")` path; Settings
  remains a separate footer action.
- **Composer attachments** —— Code composer supports text+image and image-only turns; image-only sends use a visible localized prompt as the timeline text and thread title, while empty drafts without attachments remain disabled. Image attachments can be selected or pasted from the clipboard when the corresponding Workbench Settings controls allow those entry points, generate bounded thumbnail previews inside the composer, and expose an overlaid remove control for quick deletion.

## 2. Layout grammar

```text
[ ds-workbench-shell (flex row, bg-main) ]
  ├─ Sidebar (flex 0 0 268px)        — drag-resizable
  ├─ ds-workbench-divider (5px, drag)
  ├─ main.ds-stage-surface (flex 1)
  │    ├─ Topbar
  │    ├─ MessageTimeline (Code) or WriteWorkspaceView (Write: file list + editor + assistant)
  │    ├─ FloatingComposer (Code only)
  │    └─ Right Inspector (optional, drag-resizable)
```

Right Inspector content is derived from the current timeline items: Changes lists tool activity with status and details, Todo surfaces pending approvals, failed tools, runtime errors, and unfinished latest-plan steps, and Plan shows latest-plan progress plus per-step status.
Topbar exposes the Right Inspector modes as a segmented control for Changes / Todo / Plan, with a separate Open / Close action; active mode buttons must set `aria-pressed` and keep the workspace path truncated inside the available title row.

## 3. Token usage

- **颜色**：只用 frontmatter 里声明的 4 个家族（neutral / accent / status / skill-diff）。
- **字体**：3 个 family（Sans / Display / Mono），全部声明在 `tokens.css`。
- **圆角**：≥ 6px on clickable; pill on chips; 28px on composer。
- **阴影**：3 档（card_soft / card_strong / panel / shell / composer）。

## 4. Motion

- Micro 140ms（hover、focus）
- Standard 150ms（card lift、composer border focus）
- Deep 300ms（dialog open）
- `prefers-reduced-motion: reduce` 全部归零

## 5. i18n

`zh-CN`（默认）+ `en`，key 命名空间见 frontmatter。

## 6. Message timeline

- Assistant 最终回答按 Markdown 文档渲染，不再放进高对比卡片；段落、列表、链接、任务列表、图片、分隔线、表格和代码块必须使用 `ds-markdown` 规则，并保持在中心内容列内可换行或横向滚动。
- 代码块使用 `ds-code-block` 包裹，语言标签或默认代码标签显示在顶部栏，并提供复制按钮与失败反馈；长代码块默认折叠为受限高度并提供展开/折叠控制，短代码块保持展开；宽表格使用 `ds-markdown-table-wrap` 包裹，避免模型输出撑破中心列。
- 流式 Markdown 必须能容忍模型尚未输出完整代码围栏；未闭合的三反引号代码块在渲染层临时闭合，避免 live 输出退化成普通段落。Markdown 链接和图片地址必须先经过渲染端白名单规范化；不安全协议不得生成可点击链接或可加载图片。
- 每个 turn 内先显示用户输入，再显示可折叠 `ds-work-process`。推理、工具调用、过程性 assistant 文本放入该区域，当前运行中的 turn 默认展开；用户手动展开或折叠后，流式更新不得重置该选择。
- 最终 assistant 回答之后到达的 follow-up 项必须保留在回答之后，不能被重新归入回答前的 work process；推理内容本身使用独立可折叠 process entry。
- 时间线在用户接近底部时自动跟随流式输出；用户上滑阅读旧内容时不得抢滚动，只有回到底部后恢复自动跟随。
- 工具过程使用 `ds-process-entry`：summary 显示本地化工具动作和状态，detail 展示参数与结果；失败状态使用 danger token，成功状态使用 success token。
- 计划项、系统提示和用户输入请求仍使用原有独立块，不混入 assistant 最终回答。
- Approval 块使用 `ds-approval-*` 样式；allow/deny 点击后必须进入提交中状态并禁用双按钮，参数 JSON 限高滚动，避免长参数撑开时间线。当前会话未决审批还必须在 composer 上方显示 `ds-pending-approval-*` 浮层，复用同一 diff preview 和审批按钮。

## 7. Sidebar interactions

- 线程行的主选择区域必须是可聚焦 button；归档、恢复、删除等操作放在独立 action 区，避免嵌套交互导致误触。
- 删除会话使用行内确认态，不使用系统 `confirm` 弹窗；确认态必须提供明确的确认和取消操作，并使用 danger token。
- 可拖拽分栏 separator 必须可聚焦，并支持 Arrow/Home/End 键盘调宽；焦点态使用 accent token。
- 右侧分析面板的左边缘 resizer 遵守 `right_inspector_min_px` / `right_inspector_max_px`，鼠标向左增宽、向右减宽；键盘 ArrowLeft 增宽，ArrowRight 减宽。

## 8. Write workspace

- Markdown 文件列表必须显示加载、未打开工作区、空列表和搜索无结果状态；文件行使用可聚焦 button，并展示简短元信息帮助扫描。
- 搜索框应提供一键清空入口；保存按钮只在当前文件存在且内容有变更时可用，避免把“无变化”表现成可执行保存。
- 从 Write 切换到 Code 或 Settings 前必须先 flush 当前脏文档保存；保存失败时保留在 Write，并通过状态栏暴露错误。

## 9. Settings

- 设置页使用两级结构：顶部 `ds-settings-section-tabs` 只切换设置大类，左侧 `SettingsSidebar` 只显示当前大类下的小类，中间受约束内容列展示当前“大类 + 小类”的详细配置。
- 当前“基础设置”大类包含外观与语言、启动与布局、会话与工作区三组小类；这些本地偏好选择后立即生效并保存到渲染端 localStorage，不使用模型配置保存按钮。
- 当前“大模型设置”大类包含模型档案、连接信息、上下文和推理行为四个小类；新增其它大类时必须在入口层分流，不把不同大类的配置项混入同一组小类。
- 所有写入 `runtimePreferences` 的设置控件在运行时偏好加载或保存中必须禁用，并阻止重复提交，避免旧保存响应覆盖较新的用户选择。
- 模型 profile 删除必须使用卡片内行内确认态，不使用系统 `confirm`，并提供明确的确认、取消和删除中状态。
- 模型 profile 表单处于 dirty 状态时，切换/创建/复制/删除 profile 或返回工作台必须先提示保存，不能静默丢弃未保存修改。
- Settings 返回工作台必须回到进入设置前的最近 code/write 工作台；模型 token 表单提交前必须在 renderer 做本地化正整数与上下限校验。

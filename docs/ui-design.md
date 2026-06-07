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

# ---------- 10. i18n ----------
i18n:
  locales: [en, zh-CN]
  default: zh-CN
  namespaces: [locales, usage, chat, write, threads, inspector, approvals, common, composer, settings, routes, empty]

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
- **Write** —— 打开 workspace 后，左侧文件列表，右侧 Markdown 编辑器 + 状态条。
- **Settings** —— model profile settings center with left navigation,
  constrained content column, card groups, row controls, secret input, and status feedback.

## 2. Layout grammar

```text
[ ds-workbench-shell (flex row, bg-main) ]
  ├─ Sidebar (flex 0 0 268px)        — drag-resizable
  ├─ ds-workbench-divider (5px, drag)
  ├─ main.ds-stage-surface (flex 1)
  │    ├─ Topbar
  │    ├─ MessageTimeline (Code) or WriteWorkspaceView (Write)
  │    ├─ FloatingComposer (Code only)
  │    └─ Right Inspector (optional, drag-resizable)
```

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

- Assistant 最终回答按 Markdown 文档渲染，不再放进高对比卡片；段落、列表、表格和代码块必须使用 `ds-markdown` 规则，并保持在中心内容列内可换行或横向滚动。
- 每个 turn 内先显示用户输入，再显示可折叠 `ds-work-process`。推理、工具调用、过程性 assistant 文本放入该区域，当前运行中的 turn 默认展开。
- 工具过程使用 `ds-process-entry`：summary 显示本地化工具动作和状态，detail 展示参数与结果；失败状态使用 danger token，成功状态使用 success token。
- 计划项、系统提示和用户输入请求仍使用原有独立块，不混入 assistant 最终回答。

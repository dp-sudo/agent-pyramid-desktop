export type ThemePreference = "light" | "dark";
export type DefaultStartupView = "code" | "write";
export type DefaultInspectorMode = "changes" | "todo" | "plan" | null;

export interface WorkbenchBasicPreferences {
  theme: ThemePreference;
  followSystemTheme: boolean;
  defaultStartupView: DefaultStartupView;
  rememberLeftSidebarWidth: boolean;
  leftSidebarWidth: number;
  rememberRightSidebarWidth: boolean;
  rightSidebarWidth: number;
  defaultInspectorMode: DefaultInspectorMode;
  codeBlockCollapseLineThreshold: number;
  openReasoningByDefault: boolean;
  showArchivedThreadsByDefault: boolean;
  restoreLastWorkspaceOnStartup: boolean;
  allowComposerImageUpload: boolean;
  allowComposerImagePaste: boolean;
}

const BASIC_PREFERENCES_STORAGE_KEY = "agent-pyramid.basicPreferences";
const LAST_WORKSPACE_STORAGE_KEY = "agent-pyramid.lastWorkspaceRoot";

export const LEFT_SIDEBAR_MIN_WIDTH = 180;
export const LEFT_SIDEBAR_MAX_WIDTH = 420;
export const LEFT_SIDEBAR_DEFAULT_WIDTH = 268;
export const RIGHT_INSPECTOR_MIN_WIDTH = 280;
export const RIGHT_INSPECTOR_MAX_WIDTH = 760;
export const RIGHT_INSPECTOR_DEFAULT_WIDTH = 360;
export const CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_MIN = 1;
export const CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_MAX = 200;
export const CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_DEFAULT = 18;

export const DEFAULT_BASIC_PREFERENCES: WorkbenchBasicPreferences = {
  theme: "light",
  followSystemTheme: false,
  defaultStartupView: "code",
  rememberLeftSidebarWidth: false,
  leftSidebarWidth: LEFT_SIDEBAR_DEFAULT_WIDTH,
  rememberRightSidebarWidth: false,
  rightSidebarWidth: RIGHT_INSPECTOR_DEFAULT_WIDTH,
  defaultInspectorMode: null,
  codeBlockCollapseLineThreshold: CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_DEFAULT,
  openReasoningByDefault: false,
  showArchivedThreadsByDefault: false,
  restoreLastWorkspaceOnStartup: false,
  allowComposerImageUpload: true,
  allowComposerImagePaste: true,
};

export function loadBasicPreferences(): WorkbenchBasicPreferences {
  if (typeof window === "undefined") return DEFAULT_BASIC_PREFERENCES;
  return normalizeBasicPreferences(
    readJson(window.localStorage.getItem(BASIC_PREFERENCES_STORAGE_KEY)),
  );
}

export function saveBasicPreferences(
  preferences: WorkbenchBasicPreferences,
): WorkbenchBasicPreferences {
  const normalized = normalizeBasicPreferences(preferences);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(BASIC_PREFERENCES_STORAGE_KEY, JSON.stringify(normalized));
  }
  return normalized;
}

export function loadLastWorkspaceRoot(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(LAST_WORKSPACE_STORAGE_KEY)?.trim() ?? "";
}

export function saveLastWorkspaceRoot(workspaceRoot: string): void {
  if (typeof window === "undefined") return;
  const trimmed = workspaceRoot.trim();
  if (trimmed) {
    window.localStorage.setItem(LAST_WORKSPACE_STORAGE_KEY, trimmed);
  } else {
    window.localStorage.removeItem(LAST_WORKSPACE_STORAGE_KEY);
  }
}

export function normalizeBasicPreferences(
  value: unknown,
): WorkbenchBasicPreferences {
  if (!isRecord(value)) return { ...DEFAULT_BASIC_PREFERENCES };
  return {
    theme: isThemePreference(value.theme)
      ? value.theme
      : DEFAULT_BASIC_PREFERENCES.theme,
    followSystemTheme:
      typeof value.followSystemTheme === "boolean"
        ? value.followSystemTheme
        : DEFAULT_BASIC_PREFERENCES.followSystemTheme,
    defaultStartupView: isDefaultStartupView(value.defaultStartupView)
      ? value.defaultStartupView
      : DEFAULT_BASIC_PREFERENCES.defaultStartupView,
    rememberLeftSidebarWidth:
      typeof value.rememberLeftSidebarWidth === "boolean"
        ? value.rememberLeftSidebarWidth
        : DEFAULT_BASIC_PREFERENCES.rememberLeftSidebarWidth,
    leftSidebarWidth: clampNumber(
      value.leftSidebarWidth,
      LEFT_SIDEBAR_MIN_WIDTH,
      LEFT_SIDEBAR_MAX_WIDTH,
      DEFAULT_BASIC_PREFERENCES.leftSidebarWidth,
    ),
    rememberRightSidebarWidth:
      typeof value.rememberRightSidebarWidth === "boolean"
        ? value.rememberRightSidebarWidth
        : DEFAULT_BASIC_PREFERENCES.rememberRightSidebarWidth,
    rightSidebarWidth: clampNumber(
      value.rightSidebarWidth,
      RIGHT_INSPECTOR_MIN_WIDTH,
      RIGHT_INSPECTOR_MAX_WIDTH,
      DEFAULT_BASIC_PREFERENCES.rightSidebarWidth,
    ),
    defaultInspectorMode: isDefaultInspectorMode(value.defaultInspectorMode)
      ? value.defaultInspectorMode
      : DEFAULT_BASIC_PREFERENCES.defaultInspectorMode,
    codeBlockCollapseLineThreshold: clampInteger(
      value.codeBlockCollapseLineThreshold,
      CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_MIN,
      CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_MAX,
      DEFAULT_BASIC_PREFERENCES.codeBlockCollapseLineThreshold,
    ),
    openReasoningByDefault:
      typeof value.openReasoningByDefault === "boolean"
        ? value.openReasoningByDefault
        : DEFAULT_BASIC_PREFERENCES.openReasoningByDefault,
    showArchivedThreadsByDefault:
      typeof value.showArchivedThreadsByDefault === "boolean"
        ? value.showArchivedThreadsByDefault
        : DEFAULT_BASIC_PREFERENCES.showArchivedThreadsByDefault,
    restoreLastWorkspaceOnStartup:
      typeof value.restoreLastWorkspaceOnStartup === "boolean"
        ? value.restoreLastWorkspaceOnStartup
        : DEFAULT_BASIC_PREFERENCES.restoreLastWorkspaceOnStartup,
    allowComposerImageUpload:
      typeof value.allowComposerImageUpload === "boolean"
        ? value.allowComposerImageUpload
        : DEFAULT_BASIC_PREFERENCES.allowComposerImageUpload,
    allowComposerImagePaste:
      typeof value.allowComposerImagePaste === "boolean"
        ? value.allowComposerImagePaste
        : DEFAULT_BASIC_PREFERENCES.allowComposerImagePaste,
  };
}

function readJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.warn("Failed to parse workbench basic preferences.", error);
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function clampInteger(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark";
}

function isDefaultStartupView(value: unknown): value is DefaultStartupView {
  return value === "code" || value === "write";
}

function isDefaultInspectorMode(value: unknown): value is DefaultInspectorMode {
  return value === null || value === "changes" || value === "todo" || value === "plan";
}

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_DEFAULT,
  CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_MAX,
  CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_MIN,
  DEFAULT_BASIC_PREFERENCES,
  LEFT_SIDEBAR_MAX_WIDTH,
  RIGHT_INSPECTOR_MIN_WIDTH,
  loadLastWorkspaceRoot,
  saveLastWorkspaceRoot,
  normalizeBasicPreferences,
} from "../../src/renderer/src/ui/preferences";

describe("workbench basic preferences", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes invalid preference payloads to safe defaults", () => {
    expect(normalizeBasicPreferences(null)).toEqual(DEFAULT_BASIC_PREFERENCES);
    expect(
      normalizeBasicPreferences({
        theme: "blue",
        followSystemTheme: "yes",
        defaultStartupView: "settings",
        rememberLeftSidebarWidth: true,
        leftSidebarWidth: 9999,
        rememberRightSidebarWidth: true,
        rightSidebarWidth: -1,
        defaultInspectorMode: "file",
        codeBlockCollapseLineThreshold: 2.5,
        openReasoningByDefault: "yes",
        showArchivedThreadsByDefault: true,
        restoreLastWorkspaceOnStartup: true,
        allowComposerImageUpload: false,
        allowComposerImagePaste: false,
      }),
    ).toEqual({
      ...DEFAULT_BASIC_PREFERENCES,
      rememberLeftSidebarWidth: true,
      leftSidebarWidth: LEFT_SIDEBAR_MAX_WIDTH,
      rememberRightSidebarWidth: true,
      rightSidebarWidth: RIGHT_INSPECTOR_MIN_WIDTH,
      codeBlockCollapseLineThreshold: CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_DEFAULT,
      openReasoningByDefault: DEFAULT_BASIC_PREFERENCES.openReasoningByDefault,
      showArchivedThreadsByDefault: true,
      restoreLastWorkspaceOnStartup: true,
      allowComposerImageUpload: false,
      allowComposerImagePaste: false,
    });
  });

  it("clamps persisted code block fold thresholds to the supported range", () => {
    expect(normalizeBasicPreferences({
      codeBlockCollapseLineThreshold: CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_MIN - 1,
    }).codeBlockCollapseLineThreshold).toBe(CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_MIN);

    expect(normalizeBasicPreferences({
      codeBlockCollapseLineThreshold: CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_MAX + 1,
    }).codeBlockCollapseLineThreshold).toBe(CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_MAX);

    expect(normalizeBasicPreferences({
      codeBlockCollapseLineThreshold: 42,
    }).codeBlockCollapseLineThreshold).toBe(42);
  });

  it("preserves the completed reasoning default-open preference when valid", () => {
    expect(normalizeBasicPreferences({
      openReasoningByDefault: true,
    }).openReasoningByDefault).toBe(true);

    expect(normalizeBasicPreferences({
      openReasoningByDefault: false,
    }).openReasoningByDefault).toBe(false);
  });

  it("normalizes remembered workspace roots at the localStorage boundary", () => {
    const localStorage = createMemoryStorage();
    vi.stubGlobal("window", { localStorage });

    window.localStorage.setItem("agent-pyramid.lastWorkspaceRoot", "   ");
    expect(loadLastWorkspaceRoot()).toBe("");

    saveLastWorkspaceRoot("  /workspace/project  ");
    expect(window.localStorage.getItem("agent-pyramid.lastWorkspaceRoot")).toBe("/workspace/project");
    expect(loadLastWorkspaceRoot()).toBe("/workspace/project");

    saveLastWorkspaceRoot("  ");
    expect(window.localStorage.getItem("agent-pyramid.lastWorkspaceRoot")).toBeNull();
  });
});

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

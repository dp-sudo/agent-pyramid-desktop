import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
        showArchivedThreadsByDefault: true,
        restoreLastWorkspaceOnStartup: true,
        confirmThreadDelete: false,
        allowComposerImageUpload: false,
        allowComposerImagePaste: false,
      }),
    ).toEqual({
      ...DEFAULT_BASIC_PREFERENCES,
      rememberLeftSidebarWidth: true,
      leftSidebarWidth: LEFT_SIDEBAR_MAX_WIDTH,
      rememberRightSidebarWidth: true,
      rightSidebarWidth: RIGHT_INSPECTOR_MIN_WIDTH,
      showArchivedThreadsByDefault: true,
      restoreLastWorkspaceOnStartup: true,
      confirmThreadDelete: false,
      allowComposerImageUpload: false,
      allowComposerImagePaste: false,
    });
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

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyLeftSidebarWidthPreference,
  applyBasicPreferenceUpdate,
  applyShowArchivedThreadsPreference,
  persistBasicPreferences,
  persistWorkspaceRootWhenRestored,
} from "../../src/renderer/src/ui/store/basic-preferences-state";
import {
  DEFAULT_BASIC_PREFERENCES,
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  loadLastWorkspaceRoot,
} from "../../src/renderer/src/ui/preferences";

describe("basic preferences state helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists showArchivedThreads changes through basic preferences", () => {
    vi.stubGlobal("window", { localStorage: createMemoryStorage() });

    const patch = applyShowArchivedThreadsPreference(DEFAULT_BASIC_PREFERENCES, true);

    expect(patch.showArchivedThreads).toBe(true);
    expect(patch.basicPreferences.showArchivedThreadsByDefault).toBe(true);
    expect(window.localStorage.getItem("agent-pyramid.basicPreferences")).toBeNull();

    persistBasicPreferences(patch.basicPreferences);
    expect(JSON.parse(
      window.localStorage.getItem("agent-pyramid.basicPreferences") ?? "{}",
    )).toMatchObject({
      showArchivedThreadsByDefault: true,
    });
  });

  it("persists sidebar width only when the remember preference is enabled", () => {
    vi.stubGlobal("window", { localStorage: createMemoryStorage() });

    const ignored = applyLeftSidebarWidthPreference(DEFAULT_BASIC_PREFERENCES, 320);
    const remembered = applyLeftSidebarWidthPreference({
      ...DEFAULT_BASIC_PREFERENCES,
      rememberLeftSidebarWidth: true,
    }, 320);

    expect(ignored.basicPreferences).toBe(DEFAULT_BASIC_PREFERENCES);
    expect(remembered).toMatchObject({
      leftSidebarWidth: 320,
      basicPreferences: {
        rememberLeftSidebarWidth: true,
        leftSidebarWidth: 320,
      },
    });
  });

  it("applies preference updates that depend on current workbench state", () => {
    vi.stubGlobal("window", { localStorage: createMemoryStorage() });

    const enableRememberWidth = applyBasicPreferenceUpdate({
      basicPreferences: DEFAULT_BASIC_PREFERENCES,
      workspaceRoot: "/workspace/project",
      leftSidebarWidth: 320,
      rightSidebarWidth: 480,
    }, {
      type: "updateBasicPreference",
      key: "rememberLeftSidebarWidth",
      value: true,
    });
    const disableRememberWidth = applyBasicPreferenceUpdate({
      basicPreferences: enableRememberWidth.basicPreferences,
      workspaceRoot: "/workspace/project",
      leftSidebarWidth: 320,
      rightSidebarWidth: 480,
    }, {
      type: "updateBasicPreference",
      key: "rememberLeftSidebarWidth",
      value: false,
    });
    const defaultPanel = applyBasicPreferenceUpdate({
      basicPreferences: DEFAULT_BASIC_PREFERENCES,
      workspaceRoot: "/workspace/project",
      leftSidebarWidth: 320,
      rightSidebarWidth: 480,
    }, {
      type: "updateBasicPreference",
      key: "defaultInspectorMode",
      value: "todo",
    });

    expect(enableRememberWidth.basicPreferences.leftSidebarWidth).toBe(320);
    expect(disableRememberWidth.leftSidebarWidth).toBe(LEFT_SIDEBAR_DEFAULT_WIDTH);
    expect(defaultPanel.rightPanelMode).toBe("todo");
    expect(window.localStorage.getItem("agent-pyramid.basicPreferences")).toBeNull();
  });

  it("persists and restores the last workspace root only when restore is enabled", () => {
    vi.stubGlobal("window", { localStorage: createMemoryStorage() });

    persistWorkspaceRootWhenRestored(DEFAULT_BASIC_PREFERENCES, "/ignored");
    expect(loadLastWorkspaceRoot()).toBe("");

    const enabled = {
      ...DEFAULT_BASIC_PREFERENCES,
      restoreLastWorkspaceOnStartup: true,
    };
    persistWorkspaceRootWhenRestored(enabled, "/workspace/project");
    expect(loadLastWorkspaceRoot()).toBe("/workspace/project");

    const patch = applyBasicPreferenceUpdate({
      basicPreferences: DEFAULT_BASIC_PREFERENCES,
      workspaceRoot: "",
      leftSidebarWidth: 320,
      rightSidebarWidth: 480,
    }, {
      type: "updateBasicPreference",
      key: "restoreLastWorkspaceOnStartup",
      value: true,
      restoredWorkspaceRoot: "/workspace/project",
    });
    expect(patch.workspaceRoot).toBe("/workspace/project");
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

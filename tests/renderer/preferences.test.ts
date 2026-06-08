import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASIC_PREFERENCES,
  LEFT_SIDEBAR_MAX_WIDTH,
  RIGHT_INSPECTOR_MIN_WIDTH,
  normalizeBasicPreferences,
} from "../../src/renderer/src/ui/preferences";

describe("workbench basic preferences", () => {
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
    });
  });
});

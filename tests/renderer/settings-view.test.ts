import { describe, expect, it } from "vitest";
import {
  getDefaultCategoryForSection,
  isProfileDeletePending,
  isSettingsCategoryInSection,
  shouldBlockSettingsNavigation,
  toDefaultInspectorMode,
  toDefaultInspectorModeValue,
} from "../../src/renderer/src/ui/SettingsView";

describe("SettingsView helpers", () => {
  it("tracks inline delete confirmation for a single profile", () => {
    expect(isProfileDeletePending("profile-1", "profile-1")).toBe(true);
    expect(isProfileDeletePending("profile-1", "profile-2")).toBe(false);
    expect(isProfileDeletePending(null, "profile-1")).toBe(false);
  });

  it("blocks profile-changing settings actions while dirty or failed with unsaved changes", () => {
    expect(shouldBlockSettingsNavigation("dirty")).toBe(true);
    expect(shouldBlockSettingsNavigation("idle")).toBe(false);
    expect(shouldBlockSettingsNavigation("saved")).toBe(false);
    expect(shouldBlockSettingsNavigation("error")).toBe(false);
    expect(shouldBlockSettingsNavigation("error", true)).toBe(true);
    expect(shouldBlockSettingsNavigation("error", false)).toBe(false);
    expect(shouldBlockSettingsNavigation("loading")).toBe(false);
    expect(shouldBlockSettingsNavigation("saving")).toBe(false);
  });

  it("keeps model settings as a two-level settings section", () => {
    expect(getDefaultCategoryForSection("basic")).toBe("appearance");
    expect(getDefaultCategoryForSection("model")).toBe("profiles");
    expect(isSettingsCategoryInSection("basic", "appearance")).toBe(true);
    expect(isSettingsCategoryInSection("basic", "startup")).toBe(true);
    expect(isSettingsCategoryInSection("basic", "session")).toBe(true);
    expect(isSettingsCategoryInSection("basic", "profiles")).toBe(false);
    expect(isSettingsCategoryInSection("model", "profiles")).toBe(true);
    expect(isSettingsCategoryInSection("model", "connection")).toBe(true);
    expect(isSettingsCategoryInSection("model", "context")).toBe(true);
    expect(isSettingsCategoryInSection("model", "reasoning")).toBe(true);
    expect(isSettingsCategoryInSection("model", "appearance")).toBe(false);
  });

  it("serializes the closed Inspector default as a select value", () => {
    expect(toDefaultInspectorModeValue(null)).toBe("closed");
    expect(toDefaultInspectorModeValue("changes")).toBe("changes");
    expect(toDefaultInspectorMode("closed")).toBeNull();
    expect(toDefaultInspectorMode("todo")).toBe("todo");
    expect(toDefaultInspectorMode("unknown")).toBeNull();
  });
});

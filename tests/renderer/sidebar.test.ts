import { describe, expect, it } from "vitest";
import {
  formatThreadTime,
  getWorkbenchSwitchOptions,
  isThreadActionPending,
  isThreadDeletePending,
  messageOfSidebarActionError,
  prunePendingThreadActionId,
  prunePendingThreadDeleteId,
  shouldDisableThreadAction,
} from "../../src/renderer/src/ui/components/sidebar/Sidebar";

describe("Sidebar", () => {
  it("formats thread update timestamps without seconds", () => {
    const formatted = formatThreadTime("2026-06-08T09:07:30.000Z");

    expect(formatted).toEqual(expect.any(String));
    expect(formatted.length).toBeGreaterThan(0);
  });

  it("tracks inline delete confirmation for only one thread", () => {
    expect(isThreadDeletePending("thread-1", "thread-1")).toBe(true);
    expect(isThreadDeletePending("thread-1", "thread-2")).toBe(false);
    expect(isThreadDeletePending(null, "thread-1")).toBe(false);
  });

  it("clears stale delete confirmation when the thread disappears", () => {
    expect(
      prunePendingThreadDeleteId("thread-1", [
        { id: "thread-1" },
        { id: "thread-2" },
      ]),
    ).toBe("thread-1");
    expect(prunePendingThreadDeleteId("thread-3", [{ id: "thread-1" }])).toBeNull();
    expect(prunePendingThreadDeleteId(null, [{ id: "thread-1" }])).toBeNull();
  });

  it("tracks and prunes a pending thread action", () => {
    expect(isThreadActionPending("thread-1", "thread-1")).toBe(true);
    expect(isThreadActionPending("thread-1", "thread-2")).toBe(false);
    expect(isThreadActionPending(null, "thread-1")).toBe(false);
    expect(
      prunePendingThreadActionId("thread-1", [
        { id: "thread-1" },
        { id: "thread-2" },
      ]),
    ).toBe("thread-1");
    expect(prunePendingThreadActionId("thread-3", [{ id: "thread-1" }])).toBeNull();
    expect(prunePendingThreadActionId(null, [{ id: "thread-1" }])).toBeNull();
  });

  it("disables sidebar thread actions while one action is submitting", () => {
    expect(shouldDisableThreadAction("thread-1")).toBe(true);
    expect(shouldDisableThreadAction(null)).toBe(false);
  });

  it("normalizes sidebar action errors for visible workbench feedback", () => {
    expect(messageOfSidebarActionError(new Error("archive failed"))).toBe("archive failed");
    expect(messageOfSidebarActionError("delete failed")).toBe("delete failed");
  });

  it("builds code/write workbench switch options with the active route marked", () => {
    expect(getWorkbenchSwitchOptions("code")).toEqual([
      { route: "code", labelKey: "routes.code", active: true },
      { route: "write", labelKey: "routes.write", active: false },
    ]);
    expect(getWorkbenchSwitchOptions("write")).toEqual([
      { route: "code", labelKey: "routes.code", active: false },
      { route: "write", labelKey: "routes.write", active: true },
    ]);
  });
});

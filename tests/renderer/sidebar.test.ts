import { describe, expect, it } from "vitest";
import {
  formatThreadTime,
  getThreadDeleteClickMode,
  getWorkbenchSwitchOptions,
  isThreadDeletePending,
  prunePendingThreadDeleteId,
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

  it("maps delete clicks to confirmation or immediate delete mode", () => {
    expect(getThreadDeleteClickMode(true)).toBe("confirm");
    expect(getThreadDeleteClickMode(false)).toBe("delete");
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

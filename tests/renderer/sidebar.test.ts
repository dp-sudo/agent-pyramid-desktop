import { describe, expect, it } from "vitest";
import {
  formatThreadTime,
  getThreadDeleteClickMode,
  isThreadDeletePending,
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

  it("maps delete clicks to confirmation or immediate delete mode", () => {
    expect(getThreadDeleteClickMode(true)).toBe("confirm");
    expect(getThreadDeleteClickMode(false)).toBe("delete");
  });
});

import { describe, expect, it, vi } from "vitest";
import { parseGoalUpdateRequest } from "../../../src/main/ipc/goals-handlers";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

describe("goal handlers", () => {
  it("parses clear as a strict boolean instead of JavaScript truthiness", () => {
    expect(parseGoalUpdateRequest({ threadId: " thread-1 ", clear: true })).toEqual({
      threadId: "thread-1",
      update: { goal: null },
    });
    expect(parseGoalUpdateRequest({ threadId: "thread-1", clear: false, goal: "Ship" }))
      .toEqual({
        threadId: "thread-1",
        update: { goal: "Ship" },
      });
  });

  it("rejects malformed goal update payloads at the IPC boundary", () => {
    expect(() => parseGoalUpdateRequest({ threadId: "thread-1", clear: "false" }))
      .toThrow("Goal update clear must be a boolean.");
    expect(() => parseGoalUpdateRequest({ threadId: "thread-1", status: "paused" }))
      .toThrow("Goal update status must be active, complete, or blocked.");
    expect(() => parseGoalUpdateRequest({ clear: true }))
      .toThrow("Goal update requires threadId.");
  });
});

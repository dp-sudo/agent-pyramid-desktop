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
    expect(parseGoalUpdateRequest({ threadId: "thread-1", clear: false, goal: " Ship " }))
      .toEqual({
        threadId: "thread-1",
        update: { goal: "Ship" },
      });
    expect(parseGoalUpdateRequest({
      threadId: "thread-1",
      status: "complete",
      summary: " Done ",
    })).toEqual({
      threadId: "thread-1",
      update: { status: "complete", summary: "Done" },
    });
  });

  it("rejects malformed goal update payloads at the IPC boundary", () => {
    expect(() => parseGoalUpdateRequest({ threadId: "thread-1" }))
      .toThrow("Goal update must include at least one of goal, status, or summary.");
    expect(() => parseGoalUpdateRequest({ threadId: "thread-1", clear: false }))
      .toThrow("Goal update must include at least one of goal, status, or summary.");
    expect(() => parseGoalUpdateRequest({ threadId: "thread-1", clear: true, status: "complete" }))
      .toThrow("Goal update clear cannot be combined with goal, status, or summary.");
    expect(() => parseGoalUpdateRequest({ threadId: "thread-1", goal: null, summary: "Done" }))
      .toThrow("Goal update clear cannot be combined with status or summary.");
    expect(() => parseGoalUpdateRequest({ threadId: "thread-1", clear: "false" }))
      .toThrow("Goal update clear must be a boolean.");
    expect(() => parseGoalUpdateRequest({ threadId: "thread-1", goal: " " }))
      .toThrow("Goal update goal must be a non-empty string or null.");
    expect(() => parseGoalUpdateRequest({ threadId: "thread-1", status: "paused" }))
      .toThrow("Goal update status must be active, complete, or blocked.");
    expect(() => parseGoalUpdateRequest({ threadId: "thread-1", summary: " " }))
      .toThrow("Goal update summary must be a non-empty string.");
    expect(() => parseGoalUpdateRequest({ clear: true }))
      .toThrow("Goal update requires threadId.");
  });
});

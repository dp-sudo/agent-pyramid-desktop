import { describe, expect, it } from "vitest";
import { normalizeThreadGoalUpdate } from "../../../src/main/application/thread-goal-update";

describe("normalizeThreadGoalUpdate", () => {
  it("trims goal text and summary while preserving valid status", () => {
    expect(normalizeThreadGoalUpdate({
      goal: "  Ship runtime  ",
      status: "blocked",
      summary: "  Waiting on review  ",
    })).toEqual({
      goal: "Ship runtime",
      status: "blocked",
      summary: "Waiting on review",
    });
  });

  it("allows explicit goal clear as the only update field", () => {
    expect(normalizeThreadGoalUpdate({ goal: null })).toEqual({ goal: null });
  });

  it("keeps runtime validation errors observable", () => {
    const invalidUpdates: Array<{ update: Parameters<typeof normalizeThreadGoalUpdate>[0]; message: string }> = [
      {
        update: {},
        message: "Goal update must include at least one of goal, status, or summary.",
      },
      {
        update: { goal: null, status: "active" },
        message: "Goal clear cannot be combined with status or summary.",
      },
      {
        update: { goal: " " },
        message: "Goal text is required.",
      },
      {
        update: { status: "paused" as Parameters<typeof normalizeThreadGoalUpdate>[0]["status"] },
        message: "Goal status must be active, complete, or blocked.",
      },
      {
        update: { summary: " " },
        message: "Goal summary must be a non-empty string.",
      },
    ];

    for (const item of invalidUpdates) {
      expect(() => normalizeThreadGoalUpdate(item.update)).toThrow(item.message);
    }
  });
});

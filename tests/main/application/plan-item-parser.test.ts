import { describe, expect, it } from "vitest";
import { parsePlanToolContent } from "../../../src/main/application/plan-item-parser";

describe("parsePlanToolContent", () => {
  it("converts create_plan JSON into trimmed plan fields with generated step ids", () => {
    const parsed = parsePlanToolContent(JSON.stringify({
      title: "  Test plan  ",
      steps: [
        { title: "  Write tests  ", status: "completed" },
        { title: "Implement", status: "in_progress" },
      ],
    }));

    expect(parsed.title).toBe("Test plan");
    expect(parsed.steps).toEqual([
      {
        id: expect.any(String),
        title: "Write tests",
        status: "completed",
      },
      {
        id: expect.any(String),
        title: "Implement",
        status: "in_progress",
      },
    ]);
    expect(parsed.steps[0]?.id).not.toBe(parsed.steps[1]?.id);
  });

  it("omits blank titles and defaults missing or unknown step statuses to pending", () => {
    const parsed = parsePlanToolContent(JSON.stringify({
      title: "  ",
      steps: [
        { title: "Review" },
        { title: "Ship", status: "unknown" },
      ],
    }));

    expect(parsed).not.toHaveProperty("title");
    expect(parsed.steps.map((step) => step.status)).toEqual(["pending", "pending"]);
  });

  it("keeps existing observable validation errors for malformed plan results", () => {
    const invalidPlans: Array<{ rawContent: string; message: string }> = [
      { rawContent: "null", message: "create_plan returned invalid JSON." },
      { rawContent: JSON.stringify({ steps: [] }), message: "create_plan returned no steps." },
      {
        rawContent: JSON.stringify({ steps: ["read"] }),
        message: "Plan step 1 must be an object.",
      },
      {
        rawContent: JSON.stringify({ steps: [{ title: " " }] }),
        message: "Plan step 1 requires title.",
      },
    ];

    for (const item of invalidPlans) {
      expect(() => parsePlanToolContent(item.rawContent)).toThrow(item.message);
    }
  });
});

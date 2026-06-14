import { describe, expect, it } from "vitest";
import { normalizeTurnStartRequest } from "../../../src/main/application/turn-start-request";

describe("normalizeTurnStartRequest", () => {
  it("normalizes optional turn start fields without changing public payload names", () => {
    expect(normalizeTurnStartRequest({
      threadId: " thread-1 ",
      text: " Run ",
      displayText: "Display",
      model: "model-a",
      modelProfileId: "profile-a",
      reasoningEffort: "high",
      attachmentIds: ["attachment-1"],
      mode: "plan",
      goalMode: true,
    })).toEqual({
      threadId: "thread-1",
      text: "Run",
      displayText: "Display",
      model: "model-a",
      modelProfileId: "profile-a",
      reasoningEffort: "high",
      attachmentIds: ["attachment-1"],
      mode: "plan",
      goalMode: true,
    });
  });

  it("defaults missing attachmentIds to an empty array", () => {
    expect(normalizeTurnStartRequest({
      threadId: "thread-1",
      text: "Run",
    })).toEqual({
      threadId: "thread-1",
      text: "Run",
      attachmentIds: [],
    });
  });

  it("keeps existing validation errors at the runtime boundary", () => {
    const invalidRequests: Array<{ request: unknown; message: string }> = [
      { request: null, message: "Turn start request must be an object." },
      { request: { threadId: "thread-1" }, message: "Turn text is required." },
      { request: { threadId: " ", text: "Run" }, message: "Turn threadId is required." },
      { request: { threadId: "thread-1", text: " " }, message: "Turn text is required." },
      {
        request: { threadId: "thread-1", text: "Run", displayText: 1 },
        message: "Turn displayText must be a string.",
      },
      {
        request: { threadId: "thread-1", text: "Run", model: 1 },
        message: "Turn model must be a string.",
      },
      {
        request: { threadId: "thread-1", text: "Run", modelProfileId: 1 },
        message: "Turn modelProfileId must be a string.",
      },
      {
        request: { threadId: "thread-1", text: "Run", mode: "planning" },
        message: "Turn mode must be agent or plan.",
      },
      {
        request: { threadId: "thread-1", text: "Run", reasoningEffort: "max" },
        message: "Turn reasoningEffort is invalid.",
      },
      {
        request: { threadId: "thread-1", text: "Run", attachmentIds: [42] },
        message: "Turn attachmentIds must be a string array.",
      },
      {
        request: { threadId: "thread-1", text: "Run", goalMode: "false" },
        message: "Turn goalMode must be a boolean.",
      },
    ];

    for (const item of invalidRequests) {
      expect(() => normalizeTurnStartRequest(item.request)).toThrow(item.message);
    }
  });
});

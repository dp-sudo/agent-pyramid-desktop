import { describe, expect, it } from "vitest";
import {
  isTimelineProcessOpen,
  shouldStickToTimelineBottom,
} from "../../src/renderer/src/ui/components/chat/MessageTimeline";

describe("MessageTimeline helpers", () => {
  it("sticks to the bottom while the viewport is near the latest output", () => {
    expect(
      shouldStickToTimelineBottom({
        scrollTop: 820,
        scrollHeight: 1200,
        clientHeight: 300,
        threshold: 96,
      }),
    ).toBe(true);
  });

  it("does not steal scroll when the user is reading older output", () => {
    expect(
      shouldStickToTimelineBottom({
        scrollTop: 600,
        scrollHeight: 1200,
        clientHeight: 300,
        threshold: 96,
      }),
    ).toBe(false);
  });

  it("opens the active turn process by default", () => {
    expect(
      isTimelineProcessOpen({
        turnId: "turn-1",
        activeTurnId: "turn-1",
        openByTurnId: {},
      }),
    ).toBe(true);
  });

  it("respects an explicit user process toggle over the active default", () => {
    expect(
      isTimelineProcessOpen({
        turnId: "turn-1",
        activeTurnId: "turn-1",
        openByTurnId: { "turn-1": false },
      }),
    ).toBe(false);
    expect(
      isTimelineProcessOpen({
        turnId: "turn-2",
        activeTurnId: null,
        openByTurnId: { "turn-2": true },
      }),
    ).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { canSubmitComposerDraft } from "../../src/renderer/src/ui/components/composer/FloatingComposer";

describe("FloatingComposer", () => {
  it("allows attachment-only drafts to be submitted", () => {
    expect(
      canSubmitComposerDraft({
        text: "   ",
        attachmentCount: 1,
        disabled: false,
        sendPending: false,
      }),
    ).toBe(true);
  });

  it("keeps truly empty drafts disabled", () => {
    expect(
      canSubmitComposerDraft({
        text: "   ",
        attachmentCount: 0,
        disabled: false,
        sendPending: false,
      }),
    ).toBe(false);
  });

  it("blocks submission while disabled or pending", () => {
    expect(
      canSubmitComposerDraft({
        text: "Hello",
        attachmentCount: 0,
        disabled: true,
        sendPending: false,
      }),
    ).toBe(false);
    expect(
      canSubmitComposerDraft({
        text: "Hello",
        attachmentCount: 0,
        disabled: false,
        sendPending: true,
      }),
    ).toBe(false);
  });
});

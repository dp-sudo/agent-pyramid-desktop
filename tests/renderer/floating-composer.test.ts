import { describe, expect, it } from "vitest";
import {
  canSubmitComposerDraft,
  isAttachmentRemovalDisabled,
} from "../../src/renderer/src/ui/components/composer/FloatingComposer";

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

  it("blocks attachment removal while a send or active turn can still need the blob", () => {
    expect(
      isAttachmentRemovalDisabled({
        disabled: false,
        runtimeBusy: false,
        sendPending: false,
      }),
    ).toBe(false);
    expect(
      isAttachmentRemovalDisabled({
        disabled: false,
        runtimeBusy: false,
        sendPending: true,
      }),
    ).toBe(true);
    expect(
      isAttachmentRemovalDisabled({
        disabled: false,
        runtimeBusy: true,
        sendPending: false,
      }),
    ).toBe(true);
  });
});

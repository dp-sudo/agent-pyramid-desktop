import { describe, expect, it } from "vitest";
import {
  canSubmitComposerDraft,
  getAttachmentThumbnailSrc,
  getClipboardImageFiles,
  getComposerImageAttachmentName,
  getContainSize,
  getDeleteShortcutAttachmentId,
  isAttachmentRemovalDisabled,
  normalizeSupportedComposerImageMimeType,
  partitionComposerImageFilesBySize,
} from "../../src/renderer/src/ui/components/composer/FloatingComposer";
import type { ComposerAttachment } from "../../src/renderer/src/ui/store/WorkbenchContext";

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
    expect(
      canSubmitComposerDraft({
        text: "Hello",
        attachmentCount: 0,
        disabled: false,
        sendPending: false,
        attachmentPending: true,
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
    expect(
      isAttachmentRemovalDisabled({
        disabled: false,
        runtimeBusy: false,
        sendPending: false,
        attachmentPending: true,
      }),
    ).toBe(true);
  });

  it("extracts only supported image files from clipboard items", () => {
    const png = new File(["png"], "shot.png", { type: "image/png" });
    const text = new File(["text"], "note.txt", { type: "text/plain" });

    expect(
      getClipboardImageFiles([
        clipboardFileItem(png),
        clipboardFileItem(text),
        { kind: "string", type: "text/plain", getAsFile: () => null },
      ]),
    ).toEqual([{ file: png, mimeType: "image/png" }]);
  });

  it("normalizes supported composer image mime types", () => {
    expect(normalizeSupportedComposerImageMimeType("image/png")).toBe("image/png");
    expect(normalizeSupportedComposerImageMimeType("image/jpeg")).toBe("image/jpeg");
    expect(normalizeSupportedComposerImageMimeType(" IMAGE/WEBP ")).toBe("image/webp");
    expect(normalizeSupportedComposerImageMimeType("image/svg+xml")).toBeNull();
  });

  it("partitions image files by the shared attachment size limit before upload", () => {
    const small = new File(["small"], "small.png", { type: "image/png" });
    const large = new File(["large-content"], "large.png", { type: "image/png" });

    expect(
      partitionComposerImageFilesBySize(
        [
          { file: small, mimeType: "image/png" },
          { file: large, mimeType: "image/png" },
        ],
        small.size,
      ),
    ).toEqual({
      acceptedFiles: [{ file: small, mimeType: "image/png" }],
      rejectedCount: 1,
    });
  });

  it("creates stable names for pasted images without file names", () => {
    expect(
      getComposerImageAttachmentName(
        { name: "", type: "image/jpeg" } as Pick<File, "name" | "type">,
        1,
        "paste",
      ),
    ).toBe("pasted-image-2.jpg");
    expect(
      getComposerImageAttachmentName(
        { name: "/tmp/screen.webp", type: "image/webp" } as Pick<File, "name" | "type">,
        0,
        "picker",
      ),
    ).toBe("screen.webp");
  });

  it("calculates contained thumbnail dimensions without upscaling", () => {
    expect(getContainSize(4000, 2000, 192)).toEqual({ width: 192, height: 96 });
    expect(getContainSize(120, 80, 192)).toEqual({ width: 120, height: 80 });
    expect(getContainSize(0, 80, 192)).toEqual({ width: 0, height: 0 });
  });

  it("prefers generated thumbnails over fallback preview urls", () => {
    expect(
      getAttachmentThumbnailSrc({
        thumbnailUrl: "data:image/png;base64,thumb",
        previewUrl: "blob:original",
      }),
    ).toBe("data:image/png;base64,thumb");
    expect(getAttachmentThumbnailSrc({ previewUrl: "blob:original" })).toBe(
      "blob:original",
    );
  });

  it("maps empty-text Backspace/Delete to the newest removable attachment", () => {
    const attachments: ComposerAttachment[] = [
      attachment("attachment-1"),
      attachment("attachment-2"),
    ];

    expect(
      getDeleteShortcutAttachmentId({
        key: "Backspace",
        text: "",
        attachments,
        removalDisabled: false,
      }),
    ).toBe("attachment-2");
    expect(
      getDeleteShortcutAttachmentId({
        key: "Delete",
        text: "draft",
        attachments,
        removalDisabled: false,
      }),
    ).toBeNull();
    expect(
      getDeleteShortcutAttachmentId({
        key: "Backspace",
        text: "",
        attachments,
        removalDisabled: true,
      }),
    ).toBeNull();
  });
});

function clipboardFileItem(file: File): {
  kind: string;
  type: string;
  getAsFile(): File;
} {
  return {
    kind: "file",
    type: file.type,
    getAsFile: () => file,
  };
}

function attachment(id: string): ComposerAttachment {
  return {
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    size: 10,
    createdAt: "2026-06-09T00:00:00.000Z",
    thumbnailUrl: `data:image/png;base64,${id}`,
  };
}

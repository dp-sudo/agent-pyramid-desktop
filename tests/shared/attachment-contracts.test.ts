import { describe, expect, it } from "vitest";
import {
  MAX_ATTACHMENT_BYTES,
  SUPPORTED_ATTACHMENT_MIME_TYPES,
  isAttachmentRecord,
  normalizeAttachmentName,
  normalizeSupportedAttachmentMimeType,
} from "../../src/shared/attachment-contracts";
import {
  MAX_ATTACHMENT_BYTES as BARREL_MAX_ATTACHMENT_BYTES,
  SUPPORTED_ATTACHMENT_MIME_TYPES as BARREL_SUPPORTED_ATTACHMENT_MIME_TYPES,
  isAttachmentRecord as isBarrelAttachmentRecord,
} from "../../src/shared/agent-contracts";

describe("attachment contracts", () => {
  it("owns attachment guards while the shared barrel keeps compatibility", () => {
    const record = {
      id: "00000000-0000-4000-8000-000000000201",
      name: "avatar.png",
      mimeType: "image/png",
      size: 4,
      createdAt: "2026-06-08T00:00:00.000Z",
    };

    expect(SUPPORTED_ATTACHMENT_MIME_TYPES).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
    ]);
    expect(MAX_ATTACHMENT_BYTES).toBe(12 * 1024 * 1024);
    expect(normalizeSupportedAttachmentMimeType(" IMAGE/PNG ")).toBe("image/png");
    expect(normalizeAttachmentName(" ../avatar.png ")).toBe("avatar.png");
    expect(isAttachmentRecord(record)).toBe(true);
    expect(BARREL_SUPPORTED_ATTACHMENT_MIME_TYPES).toBe(SUPPORTED_ATTACHMENT_MIME_TYPES);
    expect(BARREL_MAX_ATTACHMENT_BYTES).toBe(MAX_ATTACHMENT_BYTES);
    expect(isBarrelAttachmentRecord(record)).toBe(true);
  });
});

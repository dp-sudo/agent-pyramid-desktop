import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentStore } from "../../../src/main/persistence/attachment-store";
import { makeTempDir, removeTempDir } from "../../helpers/temp-dir";

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

describe("AttachmentStore", () => {
  let userDataDir: string;
  let store: AttachmentStore;

  beforeEach(async () => {
    userDataDir = await makeTempDir("agent-attachment-store-");
    store = new AttachmentStore(userDataDir);
  });

  afterEach(async () => {
    await removeTempDir(userDataDir);
  });

  it("creates, lists, reads, and deletes image attachments", async () => {
    const record = await store.create({
      name: "../avatar.png",
      mimeType: "image/png",
      dataBase64: ONE_PIXEL_PNG_BASE64,
    });

    expect(record.name).toBe("avatar.png");
    expect(record.size).toBeGreaterThan(0);
    expect(await store.list()).toEqual([record]);
    expect(await store.get(record.id)).toMatchObject({
      ...record,
      dataBase64: ONE_PIXEL_PNG_BASE64,
    });

    await store.delete(record.id);
    expect(await store.list()).toEqual([]);
    expect(await store.get(record.id)).toBeNull();
  });

  it("serializes concurrent creates so the attachment index keeps every record", async () => {
    const created = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.create({
          name: `image-${index}.png`,
          mimeType: "image/png",
          dataBase64: ONE_PIXEL_PNG_BASE64,
        }),
      ),
    );

    const listed = await store.list();
    expect(listed).toHaveLength(created.length);
    expect(new Set(listed.map((record) => record.id)).size).toBe(created.length);
  });

  it("rejects unsupported MIME types and missing records", async () => {
    await expect(
      store.create({
        name: "notes.txt",
        mimeType: "text/plain",
        dataBase64: ONE_PIXEL_PNG_BASE64,
      }),
    ).rejects.toThrow("Only PNG, JPEG, WebP, and GIF images are supported.");

    await expect(store.delete("missing")).rejects.toThrow("Attachment missing not found.");
  });
});

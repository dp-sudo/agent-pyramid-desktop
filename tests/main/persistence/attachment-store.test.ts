import { promises as fs } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentStore } from "../../../src/main/persistence/attachment-store";
import { MAX_ATTACHMENT_BYTES } from "../../../src/shared/agent-contracts";
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
    vi.restoreAllMocks();
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

  it("normalizes supported image MIME types at the store boundary", async () => {
    const record = await store.create({
      name: "avatar.png",
      mimeType: " IMAGE/PNG ",
      dataBase64: ONE_PIXEL_PNG_BASE64,
    });

    expect(record.mimeType).toBe("image/png");
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

    await expect(store.delete("00000000-0000-4000-8000-000000000000"))
      .rejects.toThrow("Attachment 00000000-0000-4000-8000-000000000000 not found.");
  });

  it("rejects invalid base64 payloads instead of storing decoded garbage", async () => {
    await expect(
      store.create({
        name: "broken.png",
        mimeType: "image/png",
        dataBase64: "not-base64",
      }),
    ).rejects.toThrow("Attachment dataBase64 must be valid base64.");

    await expect(
      store.create({
        name: "empty.png",
        mimeType: "image/png",
        dataBase64: "!!!!",
      }),
    ).rejects.toThrow("Attachment dataBase64 must be valid base64.");
  });

  it("rejects attachments above the shared size limit", async () => {
    await expect(
      store.create({
        name: "large.png",
        mimeType: "image/png",
        dataBase64: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64"),
      }),
    ).rejects.toThrow("Attachment exceeds the 12MB size limit.");
  });

  it("filters malformed attachment index records with the shared metadata contract", async () => {
    const valid = await store.create({
      name: "avatar.png",
      mimeType: "image/png",
      dataBase64: ONE_PIXEL_PNG_BASE64,
    });
    const indexPath = path.join(userDataDir, "attachments", "index.json");
    await fs.writeFile(
      indexPath,
      JSON.stringify([
        valid,
        { ...valid, id: "bad-id" },
        { ...valid, id: "bad-mime", mimeType: "image/svg+xml" },
        { ...valid, id: "bad-size", size: MAX_ATTACHMENT_BYTES + 1 },
      ], null, 2),
      "utf8",
    );

    await expect(store.list()).resolves.toEqual([valid]);
  });

  it("removes the attachment blob if indexing the new record fails", async () => {
    await store.init();
    await fs.rm(path.join(userDataDir, "attachments", "index.json"));
    await fs.mkdir(path.join(userDataDir, "attachments", "index.json"));

    await expect(
      store.create({
        name: "avatar.png",
        mimeType: "image/png",
        dataBase64: ONE_PIXEL_PNG_BASE64,
      }),
    ).rejects.toThrow();

    const entries = await fs.readdir(path.join(userDataDir, "attachments"));
    expect(entries.filter((entry) => entry.endsWith(".bin"))).toEqual([]);
  });

  it("keeps the index entry when blob deletion fails so cleanup can be retried", async () => {
    const record = await store.create({
      name: "avatar.png",
      mimeType: "image/png",
      dataBase64: ONE_PIXEL_PNG_BASE64,
    });
    const realRm = fs.rm.bind(fs);
    let failNextBlobDelete = true;
    vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (
        failNextBlobDelete &&
        typeof target === "string" &&
        target.endsWith(`${record.id}.bin`)
      ) {
        failNextBlobDelete = false;
        throw new Error("simulated blob delete failure");
      }
      return realRm(target, options);
    });

    await expect(store.delete(record.id)).rejects.toThrow("simulated blob delete failure");
    await expect(store.list()).resolves.toEqual([record]);

    await expect(store.delete(record.id)).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.get(record.id)).resolves.toBeNull();
  });

  it("rejects non-UUID attachment ids before resolving blob paths", async () => {
    await expect(store.get("../outside")).rejects.toThrow("Attachment id must be a UUID.");
    await expect(store.delete("../outside")).rejects.toThrow("Attachment id must be a UUID.");

    const outsidePath = path.join(userDataDir, "outside.bin");
    await fs.writeFile(outsidePath, "do not delete", "utf8");
    await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe("do not delete");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseAttachmentCreateRequest,
  parseAttachmentDeleteId,
  parseAttachmentId,
  registerAttachmentHandlers,
} from "../../../src/main/ipc/attachments-handlers";
import {
  ATTACHMENT_CREATE_CHANNEL,
  ATTACHMENT_DELETE_CHANNEL,
  ATTACHMENT_GET_CHANNEL,
} from "../../../src/shared/ipc";
import type { AttachmentStore } from "../../../src/main/persistence/attachment-store";
import type { AttachmentRecord } from "../../../src/shared/agent-contracts";

type IpcHandler = (_event: unknown, request: unknown) => Promise<unknown>;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: IpcHandler) => {
        handlers.set(channel, handler);
      }),
    },
  };
});

vi.mock("electron", () => ({
  ipcMain: electronMock.ipcMain,
}));

function createStore(): AttachmentStore {
  return {
    create: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  } as unknown as AttachmentStore;
}

describe("attachment handlers", () => {
  beforeEach(() => {
    electronMock.handlers.clear();
    electronMock.ipcMain.handle.mockClear();
  });

  it("parses attachment create and id requests at the IPC boundary", () => {
    expect(parseAttachmentCreateRequest({
      name: "image.png",
      mimeType: "image/png",
      dataBase64: "AAAA",
    })).toEqual({
      name: "image.png",
      mimeType: "image/png",
      dataBase64: "AAAA",
    });
    expect(parseAttachmentId(" attachment-1 ")).toBe("attachment-1");
    expect(parseAttachmentDeleteId({ id: " attachment-1 " })).toBe("attachment-1");
  });

  it("rejects malformed attachment create and id requests", () => {
    expect(() => parseAttachmentCreateRequest(null)).toThrow(
      "Attachment create request must be an object.",
    );
    expect(() => parseAttachmentCreateRequest({
      name: "image.png",
      mimeType: "image/png",
      dataBase64: Buffer.from("AAAA"),
    })).toThrow("Attachment dataBase64 is required.");
    expect(() => parseAttachmentId(" ")).toThrow("Attachment id is required.");
    expect(() => parseAttachmentDeleteId([])).toThrow(
      "Attachment delete request must be an object or id string.",
    );
  });

  it("creates attachments only after parsing valid create payloads", async () => {
    const store = createStore();
    const record: AttachmentRecord = {
      id: "attachment-1",
      name: "image.png",
      mimeType: "image/png",
      size: 3,
      createdAt: "2026-06-07T00:00:00.000Z",
    };
    vi.mocked(store.create).mockResolvedValue(record);
    registerAttachmentHandlers(store);
    const handler = electronMock.handlers.get(ATTACHMENT_CREATE_CHANNEL);
    if (!handler) throw new Error("Expected attachment create handler.");

    const result = await handler({}, {
      name: "image.png",
      mimeType: "image/png",
      dataBase64: "AAAA",
    });

    expect(result).toEqual({ ok: true, value: record });
    expect(store.create).toHaveBeenCalledWith({
      name: "image.png",
      mimeType: "image/png",
      dataBase64: "AAAA",
    });
  });

  it("returns an error envelope for malformed create requests", async () => {
    const store = createStore();
    registerAttachmentHandlers(store);
    const handler = electronMock.handlers.get(ATTACHMENT_CREATE_CHANNEL);
    if (!handler) throw new Error("Expected attachment create handler.");

    const result = await handler({}, {
      name: "image.png",
      mimeType: "image/png",
      dataBase64: 1,
    });

    expect(result).toEqual({
      ok: false,
      code: "ATTACHMENT_CREATE_FAILED",
      message: "Attachment dataBase64 is required.",
    });
    expect(store.create).not.toHaveBeenCalled();
  });

  it("returns an error envelope for malformed get requests", async () => {
    const store = createStore();
    registerAttachmentHandlers(store);
    const handler = electronMock.handlers.get(ATTACHMENT_GET_CHANNEL);
    if (!handler) throw new Error("Expected attachment get handler.");

    const result = await handler({}, { id: "attachment-1" });

    expect(result).toEqual({
      ok: false,
      code: "ATTACHMENT_GET_FAILED",
      message: "Attachment id is required.",
    });
    expect(store.get).not.toHaveBeenCalled();
  });

  it("returns an error envelope for malformed delete requests", async () => {
    const store = createStore();
    registerAttachmentHandlers(store);
    const handler = electronMock.handlers.get(ATTACHMENT_DELETE_CHANNEL);
    if (!handler) throw new Error("Expected attachment delete handler.");

    const result = await handler({}, undefined);

    expect(result).toEqual({
      ok: false,
      code: "ATTACHMENT_DELETE_FAILED",
      message: "Attachment delete request must be an object or id string.",
    });
    expect(store.delete).not.toHaveBeenCalled();
  });
});

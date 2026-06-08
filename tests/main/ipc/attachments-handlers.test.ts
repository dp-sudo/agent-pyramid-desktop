import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerAttachmentHandlers } from "../../../src/main/ipc/attachments-handlers";
import { ATTACHMENT_DELETE_CHANNEL } from "../../../src/shared/ipc";
import type { AttachmentStore } from "../../../src/main/persistence/attachment-store";

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

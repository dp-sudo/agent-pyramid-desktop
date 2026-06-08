import { ipcMain } from "electron";
import {
  ATTACHMENT_CREATE_CHANNEL,
  ATTACHMENT_DELETE_CHANNEL,
  ATTACHMENT_GET_CHANNEL,
} from "../../shared/ipc.js";
import type {
  AttachmentCreateRequest,
  AttachmentDeleteRequest,
} from "../../shared/agent-contracts.js";
import { err, ok } from "../../shared/agent-contracts.js";
import type { AttachmentStore } from "../persistence/attachment-store.js";

export function registerAttachmentHandlers(store: AttachmentStore): void {
  ipcMain.handle(
    ATTACHMENT_CREATE_CHANNEL,
    async (_event, request: AttachmentCreateRequest) => {
      try {
        return ok(await store.create(request));
      } catch (error) {
        return err("ATTACHMENT_CREATE_FAILED", messageOf(error));
      }
    },
  );

  ipcMain.handle(ATTACHMENT_GET_CHANNEL, async (_event, id: string) => {
    try {
      const attachment = await store.get(id);
      return attachment
        ? ok(attachment)
        : err("ATTACHMENT_NOT_FOUND", `Attachment ${id} not found.`);
    } catch (error) {
      return err("ATTACHMENT_GET_FAILED", messageOf(error));
    }
  });

  ipcMain.handle(
    ATTACHMENT_DELETE_CHANNEL,
    async (_event, request: AttachmentDeleteRequest | string) => {
      try {
        const id = parseAttachmentDeleteId(request);
        await store.delete(id);
        return ok({ id });
      } catch (error) {
        return err("ATTACHMENT_DELETE_FAILED", messageOf(error));
      }
    },
  );
}

function parseAttachmentDeleteId(request: AttachmentDeleteRequest | string): string {
  if (typeof request === "string") {
    return request;
  }
  if (!request || typeof request !== "object") {
    throw new Error("Attachment delete request must be an object or id string.");
  }
  const id = (request as { id?: unknown }).id;
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("Attachment id is required.");
  }
  return id;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

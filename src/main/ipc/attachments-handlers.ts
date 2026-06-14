import { ipcMain } from "electron";
import {
  ATTACHMENT_CREATE_CHANNEL,
  ATTACHMENT_DELETE_CHANNEL,
  ATTACHMENT_GET_CHANNEL,
} from "../../shared/ipc.js";
import { IPC_ERROR_CODES } from "../../shared/ipc-errors.js";
import type {
  AttachmentCreateRequest,
  AttachmentDeleteRequest,
} from "../../shared/agent-contracts.js";
import { err, ok } from "../../shared/agent-contracts.js";
import type { AttachmentStore } from "../persistence/attachment-store.js";
import { messageOfIpcError as messageOf } from "./ipc-result-handler.js";

export function registerAttachmentHandlers(store: AttachmentStore): void {
  ipcMain.handle(
    ATTACHMENT_CREATE_CHANNEL,
    async (_event, request: unknown) => {
      try {
        return ok(await store.create(parseAttachmentCreateRequest(request)));
      } catch (error) {
        return err(IPC_ERROR_CODES.ATTACHMENT_CREATE_FAILED, messageOf(error));
      }
    },
  );

  ipcMain.handle(ATTACHMENT_GET_CHANNEL, async (_event, request: unknown) => {
    try {
      const id = parseAttachmentId(request);
      const attachment = await store.get(id);
      return attachment
        ? ok(attachment)
        : err(IPC_ERROR_CODES.ATTACHMENT_NOT_FOUND, `Attachment ${id} not found.`);
    } catch (error) {
      return err(IPC_ERROR_CODES.ATTACHMENT_GET_FAILED, messageOf(error));
    }
  });

  ipcMain.handle(
    ATTACHMENT_DELETE_CHANNEL,
    async (_event, request: unknown) => {
      try {
        const id = parseAttachmentDeleteId(request);
        await store.delete(id);
        return ok({ id });
      } catch (error) {
        return err(IPC_ERROR_CODES.ATTACHMENT_DELETE_FAILED, messageOf(error));
      }
    },
  );
}

// Attachments cross from renderer IPC into binary persistence. Validate request
// shapes before store access so malformed payloads cannot trigger filesystem
// initialization or path/id handling as an accidental side effect.
export function parseAttachmentCreateRequest(request: unknown): AttachmentCreateRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Attachment create request must be an object.");
  }
  const value = request as Record<string, unknown>;
  return {
    name: requiredString(value.name, "Attachment name is required."),
    mimeType: requiredString(value.mimeType, "Attachment mimeType is required."),
    dataBase64: requiredString(value.dataBase64, "Attachment dataBase64 is required."),
  };
}

export function parseAttachmentId(request: unknown): string {
  if (typeof request !== "string" || !request.trim()) {
    throw new Error("Attachment id is required.");
  }
  return request.trim();
}

export function parseAttachmentDeleteId(request: unknown): string {
  if (typeof request === "string") {
    return parseAttachmentId(request);
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Attachment delete request must be an object or id string.");
  }
  return parseAttachmentId((request as AttachmentDeleteRequest).id);
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(message);
  }
  return value;
}

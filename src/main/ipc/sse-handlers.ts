import { BrowserWindow, ipcMain } from "electron";
import {
  SSE_SUBSCRIBE_CHANNEL,
  SSE_UNSUBSCRIBE_CHANNEL,
  SSE_PUSH_CHANNEL,
} from "../../shared/ipc.js";
import type {
  SseSubscribeRequest,
  SseUnsubscribeRequest,
  RuntimeEvent,
} from "../../shared/agent-contracts.js";
import { err, ok } from "../../shared/agent-contracts.js";
import { RuntimeEventBus } from "../event-bus.js";

interface Subscription {
  webContentsId: number;
  threadId: string;
  streamId?: string;
  unsubscribe: () => void;
}

const subscriptions = new Map<number, Subscription>(); // webContentsId -> subscription

export function registerSseHandlers(bus: RuntimeEventBus): void {
  ipcMain.handle(
    SSE_SUBSCRIBE_CHANNEL,
    async (event, request: SseSubscribeRequest) => {
      const webContents = event.sender;
      // Drop any existing subscription for this webContents.
      const existing = subscriptions.get(webContents.id);
      if (existing) existing.unsubscribe();

      const unsubscribe = bus.onThread(request.threadId, (evt: RuntimeEvent) => {
        if (webContents.isDestroyed()) return;
        webContents.send(SSE_PUSH_CHANNEL, evt);
      });

      const sub: Subscription = {
        webContentsId: webContents.id,
        threadId: request.threadId,
        ...(request.streamId ? { streamId: request.streamId } : {}),
        unsubscribe,
      };
      subscriptions.set(webContents.id, sub);

      webContents.once("destroyed", () => {
        const s = subscriptions.get(webContents.id);
        if (s) {
          s.unsubscribe();
          subscriptions.delete(webContents.id);
        }
      });

      return ok({ subscribed: request.threadId });
    },
  );

  ipcMain.handle(
    SSE_UNSUBSCRIBE_CHANNEL,
    async (event, request: SseUnsubscribeRequest) => {
      const sub = subscriptions.get(event.sender.id);
      if (sub && sub.threadId === request.threadId) {
        sub.unsubscribe();
        subscriptions.delete(event.sender.id);
        return ok({ unsubscribed: true });
      }
      return err("SSE_NOT_SUBSCRIBED", "No active subscription for this thread");
    },
  );

  // Best-effort cleanup when any window closes.
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.once("destroyed", () => {
      const sub = subscriptions.get(window.webContents.id);
      if (sub) {
        sub.unsubscribe();
        subscriptions.delete(window.webContents.id);
      }
    });
  });
}

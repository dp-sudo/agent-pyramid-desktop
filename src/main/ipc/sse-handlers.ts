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
  cleanup: () => void;
}

const subscriptions = new Map<number, Subscription>(); // webContentsId -> subscription

export function registerSseHandlers(bus: RuntimeEventBus): void {
  ipcMain.handle(
    SSE_SUBSCRIBE_CHANNEL,
    async (event, request: SseSubscribeRequest) => {
      const webContents = event.sender;
      // Drop any existing subscription for this webContents.
      disposeSubscription(webContents.id);

      const unsubscribe = bus.onThread(request.threadId, (evt: RuntimeEvent) => {
        if (webContents.isDestroyed()) return;
        webContents.send(SSE_PUSH_CHANNEL, evt);
      });
      const cleanup = onWebContentsDestroyed(webContents, () => {
        disposeSubscription(webContents.id);
      });

      const sub: Subscription = {
        webContentsId: webContents.id,
        threadId: request.threadId,
        ...(request.streamId ? { streamId: request.streamId } : {}),
        unsubscribe,
        cleanup,
      };
      subscriptions.set(webContents.id, sub);

      return ok({ subscribed: request.threadId });
    },
  );

  ipcMain.handle(
    SSE_UNSUBSCRIBE_CHANNEL,
    async (event, request: SseUnsubscribeRequest) => {
      const sub = subscriptions.get(event.sender.id);
      if (sub && sub.threadId === request.threadId) {
        disposeSubscription(event.sender.id);
        return ok({ unsubscribed: true });
      }
      return err("SSE_NOT_SUBSCRIBED", "No active subscription for this thread");
    },
  );

  // Best-effort cleanup when any window closes.
  BrowserWindow.getAllWindows().forEach((window) => {
    onWebContentsDestroyed(window.webContents, () => {
      disposeSubscription(window.webContents.id);
    });
  });
}

interface DestroyableWebContents {
  id: number;
  once(event: "destroyed", listener: () => void): void;
  off(event: "destroyed", listener: () => void): void;
}

function onWebContentsDestroyed(
  webContents: DestroyableWebContents,
  listener: () => void,
): () => void {
  webContents.once("destroyed", listener);
  return () => webContents.off("destroyed", listener);
}

function disposeSubscription(webContentsId: number): void {
  const sub = subscriptions.get(webContentsId);
  if (!sub) return;
  sub.unsubscribe();
  sub.cleanup();
  subscriptions.delete(webContentsId);
}

export function __resetSseSubscriptionsForTests(): void {
  for (const webContentsId of subscriptions.keys()) {
    disposeSubscription(webContentsId);
  }
}

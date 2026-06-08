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
  threadId: string;
  streamId?: string;
  unsubscribe: () => void;
}

interface WebContentsSubscriptions {
  cleanup: () => void;
  threads: Map<string, Subscription>;
}

const subscriptions = new Map<number, WebContentsSubscriptions>(); // webContentsId -> thread subscriptions

export function registerSseHandlers(bus: RuntimeEventBus): void {
  ipcMain.handle(
    SSE_SUBSCRIBE_CHANNEL,
    async (event, request: SseSubscribeRequest) => {
      const webContents = event.sender;
      const bucket = ensureWebContentsSubscriptions(webContents);
      const existing = bucket.threads.get(request.threadId);
      if (existing) {
        existing.unsubscribe();
        bucket.threads.delete(request.threadId);
      }

      const unsubscribe = bus.onThread(request.threadId, (evt: RuntimeEvent) => {
        if (webContents.isDestroyed()) return;
        webContents.send(SSE_PUSH_CHANNEL, evt);
      });
      bucket.threads.set(request.threadId, {
        threadId: request.threadId,
        ...(request.streamId ? { streamId: request.streamId } : {}),
        unsubscribe,
      });

      return ok({ subscribed: request.threadId });
    },
  );

  ipcMain.handle(
    SSE_UNSUBSCRIBE_CHANNEL,
    async (event, request: SseUnsubscribeRequest) => {
      if (disposeThreadSubscription(event.sender.id, request.threadId)) {
        return ok({ unsubscribed: true });
      }
      return err("SSE_NOT_SUBSCRIBED", "No active subscription for this thread");
    },
  );

  // Best-effort cleanup when any window closes.
  BrowserWindow.getAllWindows().forEach((window) => {
    onWebContentsDestroyed(window.webContents, () => {
      disposeWebContentsSubscriptions(window.webContents.id);
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

function ensureWebContentsSubscriptions(
  webContents: DestroyableWebContents & {
    isDestroyed(): boolean;
    send(channel: string, event: RuntimeEvent): void;
  },
): WebContentsSubscriptions {
  const existing = subscriptions.get(webContents.id);
  if (existing) return existing;
  const bucket: WebContentsSubscriptions = {
    cleanup: onWebContentsDestroyed(webContents, () => {
      disposeWebContentsSubscriptions(webContents.id);
    }),
    threads: new Map<string, Subscription>(),
  };
  subscriptions.set(webContents.id, bucket);
  return bucket;
}

function disposeThreadSubscription(webContentsId: number, threadId: string): boolean {
  const bucket = subscriptions.get(webContentsId);
  const sub = bucket?.threads.get(threadId);
  if (!bucket || !sub) return false;
  sub.unsubscribe();
  bucket.threads.delete(threadId);
  if (bucket.threads.size === 0) {
    bucket.cleanup();
    subscriptions.delete(webContentsId);
  }
  return true;
}

function disposeWebContentsSubscriptions(webContentsId: number): void {
  const bucket = subscriptions.get(webContentsId);
  if (!bucket) return;
  for (const sub of bucket.threads.values()) {
    sub.unsubscribe();
  }
  bucket.cleanup();
  subscriptions.delete(webContentsId);
}

export function __resetSseSubscriptionsForTests(): void {
  for (const webContentsId of subscriptions.keys()) {
    disposeWebContentsSubscriptions(webContentsId);
  }
}

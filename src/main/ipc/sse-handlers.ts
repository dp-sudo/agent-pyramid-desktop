import { ipcMain } from "electron";
import {
  SSE_SUBSCRIBE_CHANNEL,
  SSE_UNSUBSCRIBE_CHANNEL,
  SSE_PUSH_CHANNEL,
} from "../../shared/ipc.js";
import { IPC_ERROR_CODES } from "../../shared/ipc-errors.js";
import type {
  SseSubscribeRequest,
  SseUnsubscribeRequest,
  RuntimeEvent,
} from "../../shared/agent-contracts.js";
import { err, ok } from "../../shared/agent-contracts.js";
import { RuntimeEventBus } from "../event-bus.js";

interface Subscription {
  threadId: string;
  unsubscribe: () => void;
}

interface WebContentsSubscriptions {
  cleanup: () => void;
  threads: Map<string, Subscription>;
  unsubscribeGlobalRuntimeErrors: () => void;
}

const subscriptions = new Map<number, WebContentsSubscriptions>(); // webContentsId -> thread subscriptions

export function registerSseHandlers(bus: RuntimeEventBus): void {
  ipcMain.handle(
    SSE_SUBSCRIBE_CHANNEL,
    async (event, request: SseSubscribeRequest) => {
      try {
        const threadId = parseThreadId(request, "threadId");
        const webContents = event.sender;
        const bucket = ensureWebContentsSubscriptions(webContents, bus);
        const existing = bucket.threads.get(threadId);
        if (existing) {
          existing.unsubscribe();
          bucket.threads.delete(threadId);
        }

        const unsubscribe = bus.onThread(threadId, (evt: RuntimeEvent) => {
          if (webContents.isDestroyed()) return;
          webContents.send(SSE_PUSH_CHANNEL, evt);
        });
        bucket.threads.set(threadId, {
          threadId,
          unsubscribe,
        });

        return ok({ subscribed: threadId });
      } catch (error) {
        return err(IPC_ERROR_CODES.SSE_SUBSCRIBE_FAILED, messageOf(error));
      }
    },
  );

  ipcMain.handle(
    SSE_UNSUBSCRIBE_CHANNEL,
    async (event, request: SseUnsubscribeRequest) => {
      try {
        const threadId = parseThreadId(request, "threadId");
        if (disposeThreadSubscription(event.sender.id, threadId)) {
          return ok({ unsubscribed: true });
        }
        return err(IPC_ERROR_CODES.SSE_NOT_SUBSCRIBED, "No active subscription for this thread");
      } catch (error) {
        return err(IPC_ERROR_CODES.SSE_UNSUBSCRIBE_FAILED, messageOf(error));
      }
    },
  );

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
  bus: RuntimeEventBus,
): WebContentsSubscriptions {
  const existing = subscriptions.get(webContents.id);
  if (existing) return existing;

  // Thread subscriptions intentionally filter by threadId. A global
  // runtime_error has no threadId, so each renderer gets one bucket-level
  // listener that forwards those process-level failures without duplicating
  // them for every subscribed thread.
  const unsubscribeGlobalRuntimeErrors = bus.onKind("runtime_error", (evt: RuntimeEvent) => {
    if (evt.kind !== "runtime_error" || evt.threadId) return;
    if (webContents.isDestroyed()) return;
    webContents.send(SSE_PUSH_CHANNEL, evt);
  });
  const bucket: WebContentsSubscriptions = {
    cleanup: onWebContentsDestroyed(webContents, () => {
      disposeWebContentsSubscriptions(webContents.id);
    }),
    threads: new Map<string, Subscription>(),
    unsubscribeGlobalRuntimeErrors,
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
    disposeWebContentsSubscriptions(webContentsId);
  }
  return true;
}

function disposeWebContentsSubscriptions(webContentsId: number): void {
  const bucket = subscriptions.get(webContentsId);
  if (!bucket) return;
  for (const sub of bucket.threads.values()) {
    sub.unsubscribe();
  }
  bucket.unsubscribeGlobalRuntimeErrors();
  bucket.cleanup();
  subscriptions.delete(webContentsId);
}

function parseThreadId(request: unknown, field: string): string {
  if (!request || typeof request !== "object") {
    throw new Error("SSE request must be an object.");
  }
  const value = (request as { threadId?: unknown }).threadId;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function __resetSseSubscriptionsForTests(): void {
  for (const webContentsId of subscriptions.keys()) {
    disposeWebContentsSubscriptions(webContentsId);
  }
}

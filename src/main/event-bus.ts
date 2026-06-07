import { EventEmitter } from "node:events";
import type { RuntimeEvent, RuntimeEventKind } from "../shared/agent-contracts.js";

/**
 * Main-process event bus. The runtime emits typed RuntimeEvent values;
 * the IPC layer subscribes per-thread and forwards to the relevant
 * renderer via `webContents.send`.
 */
export class RuntimeEventBus extends EventEmitter {
  override on(eventName: RuntimeEventKind, listener: (event: RuntimeEvent) => void): this {
    return super.on(eventName, listener);
  }

  override off(eventName: RuntimeEventKind, listener: (event: RuntimeEvent) => void): this {
    return super.off(eventName, listener);
  }

  override emit(eventName: RuntimeEventKind, event: RuntimeEvent): boolean {
    return super.emit(eventName, event);
  }

  /** Convenience: subscribe to all events for a given thread. */
  onThread(threadId: string, listener: (event: RuntimeEvent) => void): () => void {
    const wrapped = (event: RuntimeEvent): void => {
      if ("threadId" in event && event.threadId === threadId) listener(event);
    };
    for (const kind of [
      "turn_started",
      "turn_completed",
      "turn_failed",
      "item_appended",
      "item_updated",
      "approval_requested",
      "runtime_error",
    ] as RuntimeEventKind[]) {
      this.on(kind, wrapped);
    }
    return () => {
      for (const kind of [
        "turn_started",
        "turn_completed",
        "turn_failed",
        "item_appended",
        "item_updated",
        "approval_requested",
        "runtime_error",
      ] as RuntimeEventKind[]) {
        this.off(kind, wrapped);
      }
    };
  }

  /** Listen to a single event kind. */
  onKind(kind: RuntimeEventKind, listener: (event: RuntimeEvent) => void): () => void {
    this.on(kind, listener);
    return () => this.off(kind, listener);
  }
}

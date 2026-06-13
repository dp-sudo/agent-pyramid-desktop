import { EventEmitter } from "node:events";
import type { RuntimeEvent, RuntimeEventKind } from "../shared/agent-contracts.js";
import {
  RUNTIME_EVENT_KINDS,
  isRuntimeEvent,
  isRuntimeEventKind,
} from "../shared/agent-contracts.js";

type EventEmitterMetaEvent = "newListener" | "removeListener";
type EventEmitterListener = (...args: unknown[]) => void;
type EventEmitterMetaListener = (
  eventName: string | symbol,
  listener: EventEmitterListener,
) => void;
type RuntimeEventListener = (event: RuntimeEvent) => void;
type RuntimeEventBusListener = RuntimeEventListener | EventEmitterMetaListener;

/**
 * Main-process event bus. The runtime emits typed RuntimeEvent values;
 * the IPC layer filters thread-scoped events by threadId and separately fans
 * out process-level runtime/MCP events that have no thread owner.
 */
export class RuntimeEventBus extends EventEmitter {
  override on(eventName: RuntimeEventKind, listener: RuntimeEventListener): this;
  override on(eventName: EventEmitterMetaEvent, listener: EventEmitterMetaListener): this;
  override on(eventName: string | symbol, listener: RuntimeEventBusListener): this {
    return super.on(eventName, listener);
  }

  override off(eventName: RuntimeEventKind, listener: RuntimeEventListener): this;
  override off(eventName: EventEmitterMetaEvent, listener: EventEmitterMetaListener): this;
  override off(eventName: string | symbol, listener: RuntimeEventBusListener): this {
    return super.off(eventName, listener);
  }

  override emit(eventName: RuntimeEventKind, event: RuntimeEvent): boolean;
  override emit(
    eventName: EventEmitterMetaEvent,
    observedEventName: string | symbol,
    listener: EventEmitterListener,
  ): boolean;
  override emit(eventName: string | symbol, ...args: unknown[]): boolean {
    if (!isRuntimeEventKind(eventName)) {
      return super.emit(eventName, ...args);
    }
    const [event] = args;
    if (!isRuntimeEvent(event)) {
      throw new Error("Runtime event shape is invalid.");
    }
    if (event.kind !== eventName) {
      throw new Error("Runtime event kind does not match emitted event name.");
    }
    return super.emit(eventName, event);
  }

  /** Convenience: subscribe to all events for a given thread. */
  onThread(threadId: string, listener: (event: RuntimeEvent) => void): () => void {
    const wrapped = (event: RuntimeEvent): void => {
      if ("threadId" in event && event.threadId === threadId) listener(event);
    };
    for (const kind of RUNTIME_EVENT_KINDS) {
      this.on(kind, wrapped);
    }
    return () => {
      for (const kind of RUNTIME_EVENT_KINDS) {
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

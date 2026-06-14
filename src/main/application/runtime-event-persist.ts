import type { RuntimeEventBus } from "../event-bus.js";
import type { JsonlThreadStore } from "../persistence/index.js";
import type {
  Item,
  RuntimeErrorEvent,
  RuntimeEvent,
} from "../../shared/agent-contracts.js";

export async function appendItemAndBroadcast(
  store: JsonlThreadStore,
  bus: RuntimeEventBus,
  threadId: string,
  turnId: string,
  item: Item,
): Promise<void> {
  await store.appendItem(threadId, item);
  bus.emit("item_appended", {
    kind: "item_appended",
    threadId,
    turnId,
    item,
  });
}

export async function persistEventOrReportError(
  store: JsonlThreadStore,
  bus: RuntimeEventBus,
  threadId: string,
  turnId: string,
  event: RuntimeEvent,
): Promise<void> {
  try {
    await store.appendEvent(threadId, event);
  } catch (error) {
    bus.emit("runtime_error", {
      kind: "runtime_error",
      threadId,
      turnId,
      code: "persistence_error",
      message: error instanceof Error ? error.message : String(error),
    } satisfies RuntimeErrorEvent);
  }
  bus.emit(event.kind, event);
}

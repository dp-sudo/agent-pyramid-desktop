import type {
  ItemUpdatedEvent,
  RuntimeEvent,
  RuntimeErrorEvent,
  ThreadRecord,
} from "../../../shared/agent-contracts";
import type { WorkbenchActions } from "./store/WorkbenchContext";
import { toolProgressUpdateFromEvent } from "./store/tool-progress-model";

export function isGlobalRuntimeErrorEvent(event: RuntimeErrorEvent): boolean {
  return event.kind === "runtime_error" && !event.threadId;
}

export function shouldBufferLiveTextItemUpdate(
  event: RuntimeEvent,
  activeThreadId: string | null,
): event is ItemUpdatedEvent {
  return (
    event.kind === "item_updated" &&
    (event.item.kind === "assistant" || event.item.kind === "reasoning") &&
    event.threadId === activeThreadId
  );
}

export function shouldFlushBufferedItemUpdatesBeforeEvent(event: RuntimeEvent): boolean {
  return event.kind === "turn_completed" || event.kind === "turn_failed";
}

type WorkbenchRuntimeEventActions = Pick<
  WorkbenchActions,
  | "appendToolProgress"
  | "appendItem"
  | "setError"
  | "turnEnded"
  | "turnStarted"
  | "updateActiveThread"
  | "updateItem"
>;

export function applyWorkbenchRuntimeEvent(
  event: RuntimeEvent,
  context: {
    activeThread: ThreadRecord | null;
    activeThreadId: string | null;
  },
  actions: WorkbenchRuntimeEventActions,
): void {
  // Retained SSE subscriptions may deliver background turn lifecycle events
  // after route switches clear the active thread; keep in-flight state correct
  // while limiting timeline mutations to the active thread.
  const activeThreadId = context.activeThreadId;
  if (event.kind === "runtime_error") {
    if (isGlobalRuntimeErrorEvent(event) || event.threadId === activeThreadId) {
      actions.setError(event.message);
    }
    return;
  }
  if (
    event.kind === "mcp_server_connection" ||
    event.kind === "mcp_tool_list_changed" ||
    event.kind === "mcp_surface_changed"
  ) {
    return;
  }

  const isActiveThreadEvent = event.threadId === activeThreadId;
  if (event.kind === "turn_started") {
    actions.turnStarted(event.turn);
  } else if (event.kind === "item_appended" && isActiveThreadEvent) {
    actions.appendItem(event.item);
  } else if (event.kind === "item_updated" && isActiveThreadEvent) {
    actions.updateItem(event.item);
  } else if (event.kind === "tool_progress" && isActiveThreadEvent) {
    actions.appendToolProgress(toolProgressUpdateFromEvent(event));
  } else if (event.kind === "turn_completed") {
    actions.turnEnded(event.threadId, event.status);
  } else if (event.kind === "tool_budget_reached") {
    // The timeline receives the persisted warning item; continuation status is not a UI error.
  } else if (event.kind === "turn_failed") {
    actions.turnEnded(event.threadId, "failed");
    if (isActiveThreadEvent) actions.setError(event.message);
  } else if (
    event.kind === "goal_updated" &&
    context.activeThread &&
    event.threadId === context.activeThread.id
  ) {
    actions.updateActiveThread({
      ...context.activeThread,
      ...(event.goal ? { goal: event.goal } : { goal: undefined }),
    });
  }
}

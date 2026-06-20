import type {
  Item,
  RuntimeEvent,
  ToolProgressEvent,
} from "../../../shared/agent-contracts";
import type { WorkbenchActions } from "./store/WorkbenchContext";
import {
  mergeToolProgressBufferEvent,
  toolProgressBufferKey,
  type ToolProgressUpdate,
} from "./store/tool-progress-model";
import {
  shouldBufferLiveTextItemUpdate,
  shouldFlushBufferedItemUpdatesBeforeEvent,
} from "./workbench-runtime-events";

const TOOL_PROGRESS_RENDER_FLUSH_MS = 100;
const TEXT_DELTA_RENDER_FLUSH_MS = 60;

type LiveEventBufferActions = Pick<
  WorkbenchActions,
  "appendToolProgress" | "updateItem"
>;

export class WorkbenchLiveEventBuffer {
  private actions: LiveEventBufferActions;
  private readonly toolProgressFlushMs: number;
  private readonly textDeltaFlushMs: number;
  private readonly toolProgressBuffers = new Map<string, ToolProgressUpdate>();
  private toolProgressFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly latestItemUpdateByItemId = new Map<string, Item>();
  private itemUpdateFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    actions: LiveEventBufferActions,
    options: {
      toolProgressFlushMs?: number;
      textDeltaFlushMs?: number;
    } = {},
  ) {
    this.actions = actions;
    this.toolProgressFlushMs =
      options.toolProgressFlushMs ?? TOOL_PROGRESS_RENDER_FLUSH_MS;
    this.textDeltaFlushMs =
      options.textDeltaFlushMs ?? TEXT_DELTA_RENDER_FLUSH_MS;
  }

  updateActions(actions: LiveEventBufferActions): void {
    this.actions = actions;
  }

  handleRuntimeEvent(event: RuntimeEvent, activeThreadId: string | null): boolean {
    if (event.kind === "tool_progress") {
      this.queueToolProgress(event);
      return true;
    }
    if (shouldBufferLiveTextItemUpdate(event, activeThreadId)) {
      this.queueItemUpdate(event.item);
      return true;
    }
    if (shouldFlushBufferedItemUpdatesBeforeEvent(event)) {
      this.flushItemUpdates();
    }
    return false;
  }

  dispose(): void {
    this.clearToolProgressTimer();
    this.clearItemUpdateTimer();
    this.toolProgressBuffers.clear();
    this.latestItemUpdateByItemId.clear();
  }

  private queueToolProgress(event: ToolProgressEvent): void {
    const key = toolProgressBufferKey(event);
    const current = this.toolProgressBuffers.get(key);
    this.toolProgressBuffers.set(key, mergeToolProgressBufferEvent(current, event));
    if (this.toolProgressFlushTimer) return;
    this.toolProgressFlushTimer = setTimeout(
      () => this.flushToolProgressBuffers(),
      this.toolProgressFlushMs,
    );
  }

  private flushToolProgressBuffers(): void {
    this.clearToolProgressTimer();
    const updates = [...this.toolProgressBuffers.values()];
    this.toolProgressBuffers.clear();
    for (const update of updates) {
      this.actions.appendToolProgress(update);
    }
  }

  private queueItemUpdate(item: Item): void {
    // Keep only the freshest snapshot per item id; the last delta in the
    // window is the one that lands in the store, so no content is lost.
    this.latestItemUpdateByItemId.set(item.id, item);
    if (this.itemUpdateFlushTimer) return;
    this.itemUpdateFlushTimer = setTimeout(
      () => this.flushItemUpdates(),
      this.textDeltaFlushMs,
    );
  }

  private flushItemUpdates(): void {
    this.clearItemUpdateTimer();
    const updates = [...this.latestItemUpdateByItemId.values()];
    this.latestItemUpdateByItemId.clear();
    for (const item of updates) {
      this.actions.updateItem(item);
    }
  }

  private clearToolProgressTimer(): void {
    if (!this.toolProgressFlushTimer) return;
    clearTimeout(this.toolProgressFlushTimer);
    this.toolProgressFlushTimer = null;
  }

  private clearItemUpdateTimer(): void {
    if (!this.itemUpdateFlushTimer) return;
    clearTimeout(this.itemUpdateFlushTimer);
    this.itemUpdateFlushTimer = null;
  }
}

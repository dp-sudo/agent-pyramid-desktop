import { describe, expect, it } from "vitest";
import {
  INITIAL_STATE,
  reducer,
  type WorkbenchState,
} from "../../src/renderer/src/ui/store/WorkbenchContext";
import type {
  AssistantItem,
  ModelConfig,
  ThreadRecord,
  ThreadSummary,
  TurnRecord,
  UserItem,
} from "../../src/shared/agent-contracts";

function thread(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    id: "thread-1",
    title: "Thread",
    workspace: "/workspace",
    mode: "code",
    status: "active",
    relation: "primary",
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
    approvalPolicy: "on-request",
    sandboxMode: "workspace-write",
    ...overrides,
  };
}

function turn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id: "turn-1",
    threadId: "thread-1",
    status: "in-flight",
    startedAt: "2026-06-07T00:00:00.000Z",
    model: "MiniMax-M3",
    mode: "agent",
    ...overrides,
  };
}

describe("WorkbenchContext reducer", () => {
  it("selects and removes active threads without leaving stale state", () => {
    const selected = reducer(INITIAL_STATE, {
      type: "selectThread",
      thread: thread(),
      items: [],
    });
    const inFlight = reducer(selected, { type: "turnStarted", turn: turn() });
    const removed = reducer(inFlight, { type: "removeThread", id: "thread-1" });

    expect(removed.activeThread).toBeNull();
    expect(removed.activeThreadId).toBeNull();
    expect(removed.activeTurnId).toBeNull();
    expect(removed.inFlightTurn).toBeNull();
    expect(removed.items).toEqual([]);
    expect(removed.rightPanelMode).toBeNull();
  });

  it("upserts appended and updated items by id", () => {
    const userItem: UserItem = {
      kind: "user",
      id: "item-1",
      threadId: "thread-1",
      turnId: "turn-1",
      text: "hello",
      createdAt: "2026-06-07T00:00:00.000Z",
    };
    const assistantItem: AssistantItem = {
      kind: "assistant",
      id: "item-1",
      threadId: "thread-1",
      turnId: "turn-1",
      text: "updated",
      createdAt: "2026-06-07T00:00:00.000Z",
    };

    const appended = reducer(INITIAL_STATE, { type: "appendItem", item: userItem });
    const updated = reducer(appended, { type: "updateItem", item: assistantItem });

    expect(updated.items).toEqual([assistantItem]);
  });

  it("keeps composer model state aligned with selected config and profile", () => {
    const config: ModelConfig = {
      ...INITIAL_STATE.modelConfig,
      model: "agnes-2.0-flash",
      model_reasoning_effort: "high",
    };
    const configured = reducer(INITIAL_STATE, { type: "setModelConfig", config });
    const selectedProfile = reducer(configured, {
      type: "setComposerModel",
      model: "deepseek-v4-flash",
      modelProfileId: "profile-2",
    });

    expect(configured.composer.model).toBe("agnes-2.0-flash");
    expect(configured.composer.reasoningEffort).toBe("high");
    expect(selectedProfile.composer).toMatchObject({
      model: "deepseek-v4-flash",
      modelProfileId: "profile-2",
    });
  });

  it("deduplicates composer attachments and removes them by id", () => {
    const withOne = reducer(INITIAL_STATE, {
      type: "addComposerAttachment",
      attachmentId: "attachment-1",
    });
    const duplicate = reducer(withOne, {
      type: "addComposerAttachment",
      attachmentId: "attachment-1",
    });
    const removed = reducer(duplicate, {
      type: "removeComposerAttachment",
      attachmentId: "attachment-1",
    });

    expect(duplicate.composer.attachmentIds).toEqual(["attachment-1"]);
    expect(removed.composer.attachmentIds).toEqual([]);
  });

  it("updates thread list and panel state independently", () => {
    const threads: ThreadSummary[] = [
      {
        id: "thread-1",
        title: "Thread",
        workspace: "/workspace",
        status: "active",
        relation: "primary",
        mode: "code",
        updatedAt: "2026-06-07T00:00:00.000Z",
      },
    ];
    const state = [
      (value: WorkbenchState) => reducer(value, { type: "setThreads", threads }),
      (value: WorkbenchState) => reducer(value, { type: "openRightPanel", mode: "plan" }),
      (value: WorkbenchState) => reducer(value, { type: "closeRightPanel" }),
    ].reduce((value, apply) => apply(value), INITIAL_STATE);

    expect(state.threads).toEqual(threads);
    expect(state.rightPanelMode).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  getActiveThreadInFlightTurn,
  getThreadInFlightTurn,
  INITIAL_STATE,
  reducer,
  shouldDeselectActiveThreadForRoute,
  type WorkbenchState,
} from "../../src/renderer/src/ui/store/WorkbenchContext";
import { DEFAULT_BASIC_PREFERENCES } from "../../src/renderer/src/ui/preferences";
import { DEFAULT_RUNTIME_PREFERENCES } from "../../src/shared/agent-contracts";
import type {
  AssistantItem,
  ModelConfig,
  ModelConfigProfilesState,
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
  it("remembers the last code or write workbench while visiting settings", () => {
    const fromWrite = reducer(INITIAL_STATE, { type: "setRoute", route: "write" });
    const settings = reducer(fromWrite, { type: "setRoute", route: "settings" });
    const backToCode = reducer(settings, { type: "setRoute", route: "code" });

    expect(fromWrite.lastWorkbenchRoute).toBe("write");
    expect(settings.lastWorkbenchRoute).toBe("write");
    expect(backToCode.lastWorkbenchRoute).toBe("code");
  });

  it("deselects active threads that do not match the target workbench route", () => {
    const selectedWrite = reducer(
      { ...INITIAL_STATE, route: "write" },
      {
        type: "selectThread",
        thread: thread({ id: "write-thread", mode: "write" }),
        items: [],
      },
    );

    expect(shouldDeselectActiveThreadForRoute("code", selectedWrite.activeThread))
      .toBe(true);
    expect(shouldDeselectActiveThreadForRoute("settings", selectedWrite.activeThread))
      .toBe(false);

    const switchedToCode = reducer(selectedWrite, { type: "setRoute", route: "code" });

    expect(switchedToCode.activeThread).toBeNull();
    expect(switchedToCode.activeThreadId).toBeNull();
    expect(switchedToCode.activeTurnId).toBeNull();
    expect(switchedToCode.items).toEqual([]);
  });

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
    expect(getThreadInFlightTurn(removed, "thread-1")).toBeNull();
    expect(removed.items).toEqual([]);
    expect(removed.rightPanelMode).toBeNull();
  });

  it("removes stale in-flight state when deleting a background thread", () => {
    const selected = reducer(INITIAL_STATE, {
      type: "selectThread",
      thread: thread({ id: "thread-1" }),
      items: [],
    });
    const firstRunning = reducer(selected, {
      type: "turnStarted",
      turn: turn({ id: "turn-1", threadId: "thread-1" }),
    });
    const secondRunning = reducer(firstRunning, {
      type: "turnStarted",
      turn: turn({ id: "turn-2", threadId: "thread-2" }),
    });

    const removed = reducer(secondRunning, { type: "removeThread", id: "thread-2" });

    expect(getThreadInFlightTurn(removed, "thread-2")).toBeNull();
    expect(getActiveThreadInFlightTurn(removed)?.id).toBe("turn-1");
    expect(removed.activeThreadId).toBe("thread-1");
  });

  it("tracks in-flight turns per thread while switching sessions", () => {
    const selected = reducer(INITIAL_STATE, {
      type: "selectThread",
      thread: thread({ id: "thread-1" }),
      items: [],
    });
    const firstRunning = reducer(selected, {
      type: "turnStarted",
      turn: turn({ id: "turn-1", threadId: "thread-1" }),
    });
    const switched = reducer(firstRunning, {
      type: "selectThread",
      thread: thread({ id: "thread-2" }),
      items: [],
    });
    const secondRunning = reducer(switched, {
      type: "turnStarted",
      turn: turn({ id: "turn-2", threadId: "thread-2" }),
    });

    expect(getThreadInFlightTurn(secondRunning, "thread-1")?.id).toBe("turn-1");
    expect(getActiveThreadInFlightTurn(secondRunning)?.id).toBe("turn-2");

    const firstEnded = reducer(secondRunning, {
      type: "turnEnded",
      threadId: "thread-1",
      status: "completed",
    });

    expect(getThreadInFlightTurn(firstEnded, "thread-1")).toBeNull();
    expect(getActiveThreadInFlightTurn(firstEnded)?.id).toBe("turn-2");
  });

  it("keeps existing turn metadata when a lighter turn_started event is merged", () => {
    const selected = reducer(INITIAL_STATE, {
      type: "selectThread",
      thread: thread({ id: "thread-1" }),
      items: [],
    });
    const fullTurn = reducer(selected, {
      type: "turnStarted",
      turn: turn({
        id: "turn-1",
        threadId: "thread-1",
        modelProfileId: "profile-1",
        reasoningEffort: "high",
      }),
    });
    const merged = reducer(fullTurn, {
      type: "turnStarted",
      turn: turn({
        id: "turn-1",
        threadId: "thread-1",
      }),
    });

    expect(getActiveThreadInFlightTurn(merged)).toMatchObject({
      id: "turn-1",
      modelProfileId: "profile-1",
      reasoningEffort: "high",
    });
  });

  it("moves an active thread summary forward when a turn starts", () => {
    const selectedThread = thread({
      id: "thread-1",
      updatedAt: "2026-06-07T00:00:00.000Z",
    });
    const selected = reducer(
      {
        ...INITIAL_STATE,
        threads: [
          {
            id: "thread-2",
            title: "Newer",
            workspace: "/workspace",
            status: "active",
            relation: "primary",
            mode: "code",
            updatedAt: "2026-06-08T00:00:00.000Z",
          },
          {
            id: "thread-1",
            title: "Older",
            workspace: "/workspace",
            status: "active",
            relation: "primary",
            mode: "code",
            updatedAt: "2026-06-07T00:00:00.000Z",
          },
        ],
      },
      {
        type: "selectThread",
        thread: selectedThread,
        items: [],
      },
    );

    const next = reducer(selected, {
      type: "turnStarted",
      turn: turn({
        threadId: "thread-1",
        startedAt: "2026-06-09T00:00:00.000Z",
      }),
    });

    expect(next.activeThread?.updatedAt).toBe("2026-06-09T00:00:00.000Z");
    expect(next.threads.map((threadSummary) => threadSummary.id)).toEqual([
      "thread-1",
      "thread-2",
    ]);
    expect(next.threads[0].updatedAt).toBe("2026-06-09T00:00:00.000Z");
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

  it("syncs runtime preferences into shared workbench state", () => {
    const preferences = {
      ...DEFAULT_RUNTIME_PREFERENCES,
      defaultApprovalPolicy: "never" as const,
      compaction: {
        ...DEFAULT_RUNTIME_PREFERENCES.compaction,
        enabled: false,
      },
    };

    const synced = reducer(INITIAL_STATE, {
      type: "setRuntimePreferences",
      preferences,
    });

    expect(synced.runtimePreferences).toEqual(preferences);
  });

  it("falls back to the active profile when the selected profile is removed", () => {
    const profiles: ModelConfigProfilesState = {
      activeProfileId: "profile-2",
      profiles: [
        {
          id: "profile-2",
          name: "Active",
          config: {
            ...INITIAL_STATE.modelConfig,
            model: "active-model",
            model_reasoning_effort: "xhigh",
          },
          createdAt: "2026-06-07T00:00:00.000Z",
          updatedAt: "2026-06-07T00:00:00.000Z",
        },
      ],
    };
    const selectedOld = reducer(INITIAL_STATE, {
      type: "setComposerModel",
      model: "old-model",
      modelProfileId: "profile-1",
    });
    const synced = reducer(selectedOld, { type: "setModelProfiles", profiles });

    expect(synced.composer).toMatchObject({
      model: "active-model",
      modelProfileId: "profile-2",
      reasoningEffort: "xhigh",
    });
  });

  it("keeps the selected composer profile when refreshed profiles still contain it", () => {
    const selected = reducer(INITIAL_STATE, {
      type: "setComposerModel",
      model: "selected-model",
      modelProfileId: "profile-1",
    });
    const profiles: ModelConfigProfilesState = {
      activeProfileId: "profile-2",
      profiles: [
        {
          id: "profile-1",
          name: "Selected",
          config: {
            ...INITIAL_STATE.modelConfig,
            model: "selected-model-updated",
            model_reasoning_effort: "medium",
          },
          createdAt: "2026-06-07T00:00:00.000Z",
          updatedAt: "2026-06-07T00:00:00.000Z",
        },
        {
          id: "profile-2",
          name: "Active",
          config: {
            ...INITIAL_STATE.modelConfig,
            model: "active-model",
            model_reasoning_effort: "xhigh",
          },
          createdAt: "2026-06-07T00:00:00.000Z",
          updatedAt: "2026-06-07T00:00:00.000Z",
        },
      ],
    };

    const refreshed = reducer(selected, { type: "setModelProfiles", profiles });

    expect(refreshed.composer).toMatchObject({
      model: "selected-model-updated",
      modelProfileId: "profile-1",
      reasoningEffort: "medium",
    });
  });

  it("syncs to the active profile when the active profile id changes", () => {
    const initialProfiles: ModelConfigProfilesState = {
      activeProfileId: "profile-1",
      profiles: [
        {
          id: "profile-1",
          name: "Selected",
          config: {
            ...INITIAL_STATE.modelConfig,
            model: "selected-model",
            model_reasoning_effort: "medium",
          },
          createdAt: "2026-06-07T00:00:00.000Z",
          updatedAt: "2026-06-07T00:00:00.000Z",
        },
        {
          id: "profile-2",
          name: "Active",
          config: {
            ...INITIAL_STATE.modelConfig,
            model: "active-model",
            model_reasoning_effort: "xhigh",
          },
          createdAt: "2026-06-07T00:00:00.000Z",
          updatedAt: "2026-06-07T00:00:00.000Z",
        },
      ],
    };
    const withInitialProfiles = reducer(INITIAL_STATE, {
      type: "setModelProfiles",
      profiles: initialProfiles,
    });
    const nextProfiles = { ...initialProfiles, activeProfileId: "profile-2" };

    const switched = reducer(withInitialProfiles, {
      type: "setModelProfiles",
      profiles: nextProfiles,
    });

    expect(switched.composer).toMatchObject({
      model: "active-model",
      modelProfileId: "profile-2",
      reasoningEffort: "xhigh",
    });
  });

  it("deduplicates composer attachments and removes them by id", () => {
    const attachment = {
      id: "attachment-1",
      name: "image.png",
      mimeType: "image/png",
      size: 12,
      createdAt: "2026-06-08T00:00:00.000Z",
      thumbnailUrl: "data:image/png;base64,attachment-1",
    };
    const withOne = reducer(INITIAL_STATE, {
      type: "addComposerAttachment",
      attachment,
    });
    const duplicate = reducer(withOne, {
      type: "addComposerAttachment",
      attachment,
    });
    const removed = reducer(duplicate, {
      type: "removeComposerAttachment",
      attachmentId: "attachment-1",
    });

    expect(duplicate.composer.attachmentIds).toEqual(["attachment-1"]);
    expect(duplicate.composer.attachments).toEqual([attachment]);
    expect(removed.composer.attachmentIds).toEqual([]);
    expect(removed.composer.attachments).toEqual([]);
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

  it("applies basic preference updates to workbench state", () => {
    const withArchived = reducer(INITIAL_STATE, {
      type: "updateBasicPreference",
      key: "showArchivedThreadsByDefault",
      value: true,
    });
    const withPanel = reducer(withArchived, {
      type: "updateBasicPreference",
      key: "defaultInspectorMode",
      value: "todo",
    });
    const withRememberedWidth = reducer(
      reducer(withPanel, { type: "setLeftSidebarWidth", width: 320 }),
      {
        type: "updateBasicPreference",
        key: "rememberLeftSidebarWidth",
        value: true,
      },
    );
    const resetWidth = reducer(withRememberedWidth, {
      type: "updateBasicPreference",
      key: "rememberLeftSidebarWidth",
      value: false,
    });

    expect(withArchived.showArchivedThreads).toBe(true);
    expect(withPanel.rightPanelMode).toBe("todo");
    expect(withRememberedWidth.basicPreferences.leftSidebarWidth).toBe(320);
    expect(resetWidth.leftSidebarWidth).toBe(DEFAULT_BASIC_PREFERENCES.leftSidebarWidth);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkbenchActions,
  getActiveThreadInFlightTurn,
  getThreadInFlightTurn,
  INITIAL_STATE,
  reducer,
  shouldDeselectActiveThreadForRoute,
  type Action,
  type WorkbenchState,
} from "../../src/renderer/src/ui/store/WorkbenchContext";
import { DEFAULT_BASIC_PREFERENCES } from "../../src/renderer/src/ui/preferences";
import { DEFAULT_RUNTIME_PREFERENCES } from "../../src/shared/agent-contracts";
import type {
  AssistantItem,
  RendererModelConfig,
  RendererModelConfigProfilesState,
  ThreadRecord,
  ThreadSummary,
  ToolItem,
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("remembers the last code or write workbench while visiting settings", () => {
    const fromWrite = reducer(INITIAL_STATE, { type: "setRoute", route: "write" });
    const settings = reducer(fromWrite, { type: "setRoute", route: "settings" });
    const backToCode = reducer(settings, { type: "setRoute", route: "code" });

    expect(fromWrite.lastWorkbenchRoute).toBe("write");
    expect(settings.lastWorkbenchRoute).toBe("write");
    expect(backToCode.lastWorkbenchRoute).toBe("code");
  });

  it("deselects active threads that do not match the target workbench route", () => {
    const writeRoute = reducer(INITIAL_STATE, { type: "setRoute", route: "write" });
    const selectedWrite = reducer(
      writeRoute,
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

  it("keeps active thread selection while entering settings", () => {
    const item: UserItem = {
      kind: "user",
      id: "item-1",
      threadId: "write-thread",
      turnId: "turn-1",
      text: "draft context",
      createdAt: "2026-06-07T00:00:00.000Z",
    };
    const writeRoute = reducer(INITIAL_STATE, { type: "setRoute", route: "write" });
    const selectedWrite = reducer(
      writeRoute,
      {
        type: "selectThread",
        thread: thread({ id: "write-thread", mode: "write" }),
        items: [item],
      },
    );

    const settings = reducer(selectedWrite, { type: "setRoute", route: "settings" });

    expect(settings.activeThread?.id).toBe("write-thread");
    expect(settings.activeThreadId).toBe("write-thread");
    expect(settings.items).toEqual([item]);
    expect(settings.lastWorkbenchRoute).toBe("write");
  });

  it("deselects active threads without leaving a stale inspector panel", () => {
    const selected = reducer(INITIAL_STATE, {
      type: "selectThread",
      thread: thread(),
      items: [],
    });
    const withInspector = reducer(selected, { type: "openRightPanel", mode: "todo" });

    const deselected = reducer(withInspector, { type: "deselectThread" });

    expect(deselected.activeThread).toBeNull();
    expect(deselected.activeThreadId).toBeNull();
    expect(deselected.activeTurnId).toBeNull();
    expect(deselected.items).toEqual([]);
    expect(deselected.rightPanelMode).toBeNull();
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

  it("appends tool progress to running tool items and leaves completed results untouched", () => {
    const runningTool: ToolItem = {
      kind: "tool",
      id: "tool-1",
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      name: "run_command",
      args: { command: "npm test" },
      status: "running",
      createdAt: "2026-06-07T00:00:00.000Z",
    };
    const selected = reducer(INITIAL_STATE, {
      type: "selectThread",
      thread: thread(),
      items: [runningTool],
    });

    const withStdout = reducer(selected, {
      type: "appendToolProgress",
      progress: {
        threadId: "thread-1",
        turnId: "turn-1",
        toolCallId: "call-1",
        seq: 1,
        stdout: "out-1\n",
      },
    });
    const withStderr = reducer(withStdout, {
      type: "appendToolProgress",
      progress: {
        threadId: "thread-1",
        turnId: "turn-1",
        toolCallId: "call-1",
        seq: 2,
        stderr: "err-1\n",
      },
    });

    expect(withStderr.items[0]).toMatchObject({
      result: {
        kind: "tool_progress",
        stdout: "out-1\n",
        stderr: "err-1\n",
      },
    });

    const completed = reducer(withStderr, {
      type: "updateItem",
      item: {
        ...runningTool,
        status: "completed",
        result: { stdout: "final\n" },
      },
    });
    const ignored = reducer(completed, {
      type: "appendToolProgress",
      progress: {
        threadId: "thread-1",
        turnId: "turn-1",
        toolCallId: "call-1",
        seq: 3,
        stdout: "late\n",
      },
    });

    expect(ignored.items[0]).toMatchObject({
      status: "completed",
      result: { stdout: "final\n" },
    });
  });

  it("keeps composer model state aligned with selected config and profile", () => {
    const config: RendererModelConfig = {
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
      modelProfileSelection: "explicit",
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
    const profiles: RendererModelConfigProfilesState = {
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
      modelProfileSelection: "auto",
      reasoningEffort: "xhigh",
    });
  });

  it("keeps the selected composer profile when refreshed profiles still contain it", () => {
    const selected = reducer(INITIAL_STATE, {
      type: "setComposerModel",
      model: "selected-model",
      modelProfileId: "profile-1",
    });
    const profiles: RendererModelConfigProfilesState = {
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
      modelProfileSelection: "explicit",
      reasoningEffort: "medium",
    });
  });

  it("syncs to the active profile when the active profile id changes", () => {
    const initialProfiles: RendererModelConfigProfilesState = {
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
      modelProfileSelection: "auto",
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
    const withReasoningOpen = reducer(withRememberedWidth, {
      type: "updateBasicPreference",
      key: "openReasoningByDefault",
      value: true,
    });
    const resetWidth = reducer(withReasoningOpen, {
      type: "updateBasicPreference",
      key: "rememberLeftSidebarWidth",
      value: false,
    });

    expect(withArchived.showArchivedThreads).toBe(true);
    expect(withPanel.rightPanelMode).toBe("todo");
    expect(withRememberedWidth.basicPreferences.leftSidebarWidth).toBe(320);
    expect(withReasoningOpen.basicPreferences.openReasoningByDefault).toBe(true);
    expect(resetWidth.leftSidebarWidth).toBe(DEFAULT_BASIC_PREFERENCES.leftSidebarWidth);
  });

  it("keeps workbench actions reading the latest state", () => {
    vi.stubGlobal("window", { localStorage: createMemoryStorage() });
    let state: WorkbenchState = {
      ...INITIAL_STATE,
      workspaceRoot: "/old-workspace",
      basicPreferences: {
        ...INITIAL_STATE.basicPreferences,
        restoreLastWorkspaceOnStartup: false,
      },
    };
    const dispatched: Action[] = [];
    const actions = createWorkbenchActions(
      () => state,
      (action) => {
        dispatched.push(action);
        state = reducer(state, action);
      },
    );

    state = {
      ...state,
      workspaceRoot: "/latest-workspace",
      basicPreferences: {
        ...state.basicPreferences,
        restoreLastWorkspaceOnStartup: true,
      },
    };

    actions.updateBasicPreference("restoreLastWorkspaceOnStartup", true);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "updateBasicPreference",
      key: "restoreLastWorkspaceOnStartup",
      value: true,
    });
    expect(state.workspaceRoot).toBe("/latest-workspace");
    expect(window.localStorage.getItem("agent-pyramid.lastWorkspaceRoot"))
      .toBe("/latest-workspace");
  });
});

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

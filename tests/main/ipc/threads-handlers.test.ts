import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseThreadCreateInput,
  parseThreadId,
  parseThreadListFilter,
  parseThreadUpdatePatch,
  registerThreadHandlers,
} from "../../../src/main/ipc/threads-handlers";
import {
  THREAD_CREATE_CHANNEL,
  THREAD_DELETE_CHANNEL,
  THREAD_LIST_CHANNEL,
  THREAD_UPDATE_CHANNEL,
} from "../../../src/shared/ipc";
import type { AgentRuntime } from "../../../src/main/application/agent-runtime";
import type { JsonlThreadStore } from "../../../src/main/persistence/index";
import type { RuntimePreferencesStore } from "../../../src/main/persistence/runtime-preferences-store";
import {
  DEFAULT_RUNTIME_PREFERENCES,
  type ThreadGoal,
  type ThreadRecord,
  type ThreadSummary,
} from "../../../src/shared/agent-contracts";

type IpcHandler = (_event: unknown, ...args: unknown[]) => Promise<unknown>;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: IpcHandler) => {
        handlers.set(channel, handler);
      }),
    },
  };
});

vi.mock("electron", () => ({
  ipcMain: electronMock.ipcMain,
}));

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

function summary(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: "thread-1",
    title: "Thread",
    workspace: "/workspace",
    mode: "code",
    status: "active",
    relation: "primary",
    updatedAt: "2026-06-07T00:00:00.000Z",
    ...overrides,
  };
}

function goal(overrides: Partial<ThreadGoal> = {}): ThreadGoal {
  return {
    text: "Ship goal",
    status: "active",
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
    ...overrides,
  };
}

function createStore(): JsonlThreadStore {
  return {
    listThreads: vi.fn(),
    createThread: vi.fn(),
    getThread: vi.fn(),
    updateThread: vi.fn(),
    deleteThread: vi.fn(),
    forkThread: vi.fn(),
  } as unknown as JsonlThreadStore;
}

function createRuntime(): AgentRuntime {
  return {
    isThreadInFlight: vi.fn(),
  } as unknown as AgentRuntime;
}

function createRuntimePreferencesStore(): RuntimePreferencesStore {
  return {
    get: vi.fn(),
  } as unknown as RuntimePreferencesStore;
}

describe("thread handlers", () => {
  beforeEach(() => {
    electronMock.handlers.clear();
    electronMock.ipcMain.handle.mockClear();
  });

  it("parses thread request payloads at the IPC boundary", () => {
    expect(parseThreadId(" thread-1 ", "Thread get")).toBe("thread-1");
    expect(parseThreadListFilter({
      include: ["primary", "side"],
      mode: "write",
      search: "notes",
      includeArchived: true,
    })).toEqual({
      include: ["primary", "side"],
      mode: "write",
      search: "notes",
      includeArchived: true,
    });
    expect(parseThreadCreateInput({
      workspace: "/workspace",
      mode: "code",
      title: "New",
      relation: "primary",
      approvalPolicy: "never",
      sandboxMode: "read-only",
    })).toEqual({
      workspace: "/workspace",
      mode: "code",
      title: "New",
      relation: "primary",
      approvalPolicy: "never",
      sandboxMode: "read-only",
    });
    expect(parseThreadUpdatePatch({
      title: "Renamed",
      status: "archived",
      approvalPolicy: "never",
      sandboxMode: "read-only",
      goal: goal(),
    })).toEqual({
      title: "Renamed",
      status: "archived",
      approvalPolicy: "never",
      sandboxMode: "read-only",
      goal: goal(),
    });
    expect(parseThreadUpdatePatch({ goal: null })).toEqual({ goal: null });
  });

  it("rejects malformed thread request payloads", () => {
    expect(() => parseThreadId("", "Thread get")).toThrow(
      "Thread get requires a thread id string.",
    );
    expect(() => parseThreadListFilter({ includeArchived: "false" })).toThrow(
      "Thread list includeArchived must be a boolean.",
    );
    expect(() => parseThreadCreateInput({ workspace: "/workspace", mode: "invalid" }))
      .toThrow("Thread create mode is invalid.");
    expect(() =>
      parseThreadCreateInput({ workspace: "/workspace", mode: "code", relation: "fork" })
    ).toThrow("Thread create fork requires parentThreadId.");
    expect(() =>
      parseThreadCreateInput({
        workspace: "/workspace",
        mode: "code",
        relation: "primary",
        parentThreadId: "00000000-0000-4000-8000-000000000101",
      })
    ).toThrow("Thread create parentThreadId requires relation fork.");
    expect(() =>
      parseThreadCreateInput({
        workspace: "/workspace",
        mode: "code",
        approvalPolicy: "sometimes",
      })
    ).toThrow("Thread create approvalPolicy is invalid.");
    expect(() =>
      parseThreadCreateInput({
        workspace: "/workspace",
        mode: "code",
        sandboxMode: "workspace",
      })
    ).toThrow("Thread create sandboxMode is invalid.");
    expect(() => parseThreadUpdatePatch({})).toThrow(
      "Thread update patch must include at least one field.",
    );
    expect(() => parseThreadUpdatePatch({ status: "paused" }))
      .toThrow("Thread status must be active or archived.");
    expect(() => parseThreadUpdatePatch({ goal: { text: "Ship", status: "paused" } }))
      .toThrow("Thread update goal is invalid.");
  });

  it("returns an error envelope for malformed create requests before store access", async () => {
    const store = createStore();
    registerThreadHandlers(store);
    const handler = electronMock.handlers.get(THREAD_CREATE_CHANNEL);
    if (!handler) throw new Error("Expected thread create handler.");

    const result = await handler({}, { workspace: "/workspace", mode: "invalid" });

    expect(result).toEqual({
      ok: false,
      code: "THREAD_CREATE_FAILED",
      message: "Thread create mode is invalid.",
    });
    expect(store.createThread).not.toHaveBeenCalled();
  });

  it("applies runtime permission defaults when creating a thread through IPC", async () => {
    const store = createStore();
    const runtimePreferencesStore = createRuntimePreferencesStore();
    vi.mocked(runtimePreferencesStore.get).mockResolvedValue({
      ...DEFAULT_RUNTIME_PREFERENCES,
      defaultApprovalPolicy: "never",
      defaultSandboxMode: "read-only",
    });
    vi.mocked(store.createThread).mockResolvedValue(thread({
      approvalPolicy: "never",
      sandboxMode: "read-only",
    }));
    registerThreadHandlers(store, undefined, runtimePreferencesStore);
    const handler = electronMock.handlers.get(THREAD_CREATE_CHANNEL);
    if (!handler) throw new Error("Expected thread create handler.");

    const result = await handler({}, { workspace: "/workspace", mode: "code" });

    expect(result).toEqual({
      ok: true,
      value: thread({ approvalPolicy: "never", sandboxMode: "read-only" }),
    });
    expect(store.createThread).toHaveBeenCalledWith({
      workspace: "/workspace",
      mode: "code",
      approvalPolicy: "never",
      sandboxMode: "read-only",
    });
  });

  it("passes parsed list filters to the store", async () => {
    const store = createStore();
    vi.mocked(store.listThreads).mockResolvedValue([summary()]);
    registerThreadHandlers(store);
    const handler = electronMock.handlers.get(THREAD_LIST_CHANNEL);
    if (!handler) throw new Error("Expected thread list handler.");

    const result = await handler({}, { mode: "code", archivedOnly: false });

    expect(result).toEqual({ ok: true, value: [summary()] });
    expect(store.listThreads).toHaveBeenCalledWith({ mode: "code", archivedOnly: false });
  });

  it("returns an error envelope for malformed delete requests before store access", async () => {
    const store = createStore();
    registerThreadHandlers(store);
    const handler = electronMock.handlers.get(THREAD_DELETE_CHANNEL);
    if (!handler) throw new Error("Expected thread delete handler.");

    const result = await handler({}, { id: "thread-1" });

    expect(result).toEqual({
      ok: false,
      code: "THREAD_DELETE_FAILED",
      message: "Thread delete requires a thread id string.",
    });
    expect(store.getThread).not.toHaveBeenCalled();
    expect(store.deleteThread).not.toHaveBeenCalled();
  });

  it("preserves the dedicated invalid status error code on update", async () => {
    const store = createStore();
    registerThreadHandlers(store);
    const handler = electronMock.handlers.get(THREAD_UPDATE_CHANNEL);
    if (!handler) throw new Error("Expected thread update handler.");

    const result = await handler({}, "thread-1", { status: "paused" });

    expect(result).toEqual({
      ok: false,
      code: "THREAD_STATUS_INVALID",
      message: "Thread status must be active or archived.",
    });
    expect(store.getThread).not.toHaveBeenCalled();
    expect(store.updateThread).not.toHaveBeenCalled();
  });

  it("returns an error envelope for empty update patches before store access", async () => {
    const store = createStore();
    registerThreadHandlers(store);
    const handler = electronMock.handlers.get(THREAD_UPDATE_CHANNEL);
    if (!handler) throw new Error("Expected thread update handler.");

    const result = await handler({}, "thread-1", {});

    expect(result).toEqual({
      ok: false,
      code: "THREAD_UPDATE_FAILED",
      message: "Thread update patch must include at least one field.",
    });
    expect(store.getThread).not.toHaveBeenCalled();
    expect(store.updateThread).not.toHaveBeenCalled();
  });

  it("returns an error envelope for malformed goal patches before store access", async () => {
    const store = createStore();
    registerThreadHandlers(store);
    const handler = electronMock.handlers.get(THREAD_UPDATE_CHANNEL);
    if (!handler) throw new Error("Expected thread update handler.");

    const result = await handler({}, "thread-1", { goal: { text: "Ship", status: "paused" } });

    expect(result).toEqual({
      ok: false,
      code: "THREAD_UPDATE_FAILED",
      message: "Thread update goal is invalid.",
    });

    const blankTextResult = await handler({}, "thread-1", {
      goal: goal({ text: "   " }),
    });
    expect(blankTextResult).toEqual({
      ok: false,
      code: "THREAD_UPDATE_FAILED",
      message: "Thread update goal is invalid.",
    });

    const blankSummaryResult = await handler({}, "thread-1", {
      goal: goal({ summary: "   " }),
    });
    expect(blankSummaryResult).toEqual({
      ok: false,
      code: "THREAD_UPDATE_FAILED",
      message: "Thread update goal is invalid.",
    });
    expect(store.getThread).not.toHaveBeenCalled();
    expect(store.updateThread).not.toHaveBeenCalled();
  });

  it("keeps archive busy checks after parsing update payloads", async () => {
    const store = createStore();
    const runtime = createRuntime();
    vi.mocked(store.getThread).mockResolvedValue(thread());
    vi.mocked(runtime.isThreadInFlight).mockReturnValue(true);
    registerThreadHandlers(store, runtime);
    const handler = electronMock.handlers.get(THREAD_UPDATE_CHANNEL);
    if (!handler) throw new Error("Expected thread update handler.");

    const result = await handler({}, "thread-1", { status: "archived" });

    expect(result).toEqual({
      ok: false,
      code: "THREAD_ARCHIVE_BUSY",
      message: "Cannot archive a thread while a turn is running.",
    });
    expect(store.updateThread).not.toHaveBeenCalled();
  });
});

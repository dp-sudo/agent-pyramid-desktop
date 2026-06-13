import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseCheckpointListRequest,
  parseCheckpointRewindRequest,
  registerCheckpointHandlers,
} from "../../../src/main/ipc/checkpoints-handlers";
import type { AgentRuntime } from "../../../src/main/application/agent-runtime";
import { CheckpointStore } from "../../../src/main/persistence/checkpoint-store";
import { JsonlThreadStore } from "../../../src/main/persistence/index";
import type { Item, RuntimeEvent } from "../../../src/shared/agent-contracts";
import {
  CHECKPOINT_LIST_CHANNEL,
  CHECKPOINT_REWIND_CHANNEL,
} from "../../../src/shared/ipc";
import { makeTempDir, removeTempDir } from "../../helpers/temp-dir";

type IpcHandler = (_event: unknown, request?: unknown) => Promise<unknown>;

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

describe("checkpoint handlers", () => {
  let userDataDir: string;
  let workspace: string;
  let threadStore: JsonlThreadStore;
  let checkpointStore: CheckpointStore;

  beforeEach(async () => {
    electronMock.handlers.clear();
    electronMock.ipcMain.handle.mockClear();
    userDataDir = await makeTempDir("agent-checkpoint-ipc-");
    workspace = await makeTempDir("agent-checkpoint-ipc-workspace-");
    threadStore = new JsonlThreadStore(userDataDir);
    checkpointStore = new CheckpointStore(userDataDir);
    await checkpointStore.init();
  });

  afterEach(async () => {
    await removeTempDir(userDataDir);
    await removeTempDir(workspace);
  });

  it("parses checkpoint IPC requests", () => {
    expect(parseCheckpointListRequest({ threadId: "thread-1" })).toEqual({
      threadId: "thread-1",
    });
    expect(parseCheckpointRewindRequest({
      threadId: "thread-1",
      turnId: "turn-1",
      rewindSession: true,
    })).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      rewindSession: true,
    });
    expect(() => parseCheckpointListRequest(null)).toThrow(
      "Checkpoint list request must be an object.",
    );
    expect(() => parseCheckpointRewindRequest({ threadId: "thread-1", turnId: "turn-1", rewindSession: "yes" }))
      .toThrow("Checkpoint rewindSession must be a boolean.");
  });

  it("lists checkpoint metadata for a thread", async () => {
    const thread = await threadStore.createThread({
      workspace,
      mode: "code",
    });
    await checkpointStore.beginTurn({
      threadId: thread.id,
      turnId: "turn-1",
      workspace,
      prompt: "edit",
      createdAt: "2026-06-12T01:00:00.000Z",
    });
    registerCheckpointHandlers(checkpointStore, threadStore);
    const handler = getHandler(CHECKPOINT_LIST_CHANNEL);

    const result = await handler({}, { threadId: thread.id });

    expect(result).toEqual({
      ok: true,
      value: {
        threadId: thread.id,
        checkpoints: [
          expect.objectContaining({
            threadId: thread.id,
            turnId: "turn-1",
            prompt: "edit",
          }),
        ],
      },
    });
  });

  it("rejects rewind while a thread is running", async () => {
    const thread = await threadStore.createThread({
      workspace,
      mode: "code",
    });
    const runtime = {
      isThreadInFlight: (threadId: string) => threadId === thread.id,
    } as AgentRuntime;
    registerCheckpointHandlers(checkpointStore, threadStore, runtime);
    const handler = getHandler(CHECKPOINT_REWIND_CHANNEL);

    const result = await handler({}, {
      threadId: thread.id,
      turnId: "turn-1",
      rewindSession: false,
    });

    expect(result).toEqual({
      ok: false,
      code: "CHECKPOINT_REWIND_BUSY",
      message: "Cannot rewind a thread while a turn is running.",
    });
  });

  it("rewinds code and truncates session history", async () => {
    const thread = await threadStore.createThread({
      workspace,
      mode: "code",
    });
    await fs.writeFile(path.join(workspace, "a.txt"), "v0\n", "utf8");

    const firstItem = userItem(thread.id, "turn-0", "item-0", "first");
    const secondItem = userItem(thread.id, "turn-1", "item-1", "second");
    await threadStore.appendItem(thread.id, firstItem);
    await threadStore.appendItem(thread.id, secondItem);
    await threadStore.appendEvent(thread.id, itemEvent(thread.id, "turn-0", firstItem));
    await threadStore.appendEvent(thread.id, itemEvent(thread.id, "turn-1", secondItem));

    await checkpointStore.beginTurn({
      threadId: thread.id,
      turnId: "turn-0",
      workspace,
      prompt: "first",
      createdAt: "2026-06-12T01:00:00.000Z",
    });
    await checkpointStore.recordFileSnapshot({
      threadId: thread.id,
      turnId: "turn-0",
      workspace,
      toolName: "edit_file",
      relativePath: "a.txt",
      operation: "update",
      beforeContent: "v0\n",
      afterContent: "v1\n",
      beforeSha256: sha256("v0\n"),
      afterSha256: sha256("v1\n"),
    });
    await fs.writeFile(path.join(workspace, "a.txt"), "v1\n", "utf8");
    await checkpointStore.beginTurn({
      threadId: thread.id,
      turnId: "turn-1",
      workspace,
      prompt: "second",
      createdAt: "2026-06-12T02:00:00.000Z",
    });
    await checkpointStore.recordFileSnapshot({
      threadId: thread.id,
      turnId: "turn-1",
      workspace,
      toolName: "edit_file",
      relativePath: "a.txt",
      operation: "update",
      beforeContent: "v1\n",
      afterContent: "v2\n",
      beforeSha256: sha256("v1\n"),
      afterSha256: sha256("v2\n"),
    });
    await fs.writeFile(path.join(workspace, "a.txt"), "v2\n", "utf8");

    registerCheckpointHandlers(checkpointStore, threadStore);
    const handler = getHandler(CHECKPOINT_REWIND_CHANNEL);
    const result = await handler({}, {
      threadId: thread.id,
      turnId: "turn-1",
      rewindSession: true,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        threadId: thread.id,
        turnId: "turn-1",
        rewindSession: true,
        restoredPaths: ["a.txt"],
        deletedPaths: [],
        itemsRemoved: 1,
        eventsRemoved: 1,
        checkpointsRemoved: 1,
      },
    });
    expect(await fs.readFile(path.join(workspace, "a.txt"), "utf8")).toBe("v1\n");
    const items: Item[] = [];
    for await (const item of threadStore.replayItems(thread.id)) {
      items.push(item);
    }
    expect(items).toEqual([firstItem]);
    expect((await checkpointStore.list(thread.id)).map((checkpoint) => checkpoint.turnId))
      .toEqual(["turn-0"]);
  });
});

function getHandler(channel: string): IpcHandler {
  const handler = electronMock.handlers.get(channel);
  if (!handler) throw new Error(`Expected handler for ${channel}.`);
  return handler;
}

function userItem(threadId: string, turnId: string, id: string, text: string): Item {
  return {
    kind: "user",
    id,
    threadId,
    turnId,
    text,
    createdAt: "2026-06-12T00:00:00.000Z",
  };
}

function itemEvent(threadId: string, turnId: string, item: Item): RuntimeEvent {
  return {
    kind: "item_appended",
    threadId,
    turnId,
    item,
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

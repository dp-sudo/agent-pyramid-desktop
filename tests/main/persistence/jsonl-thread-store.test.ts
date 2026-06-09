import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonlThreadStore } from "../../../src/main/persistence/index";
import type { Item, RuntimeEvent, ThreadRecord, ThreadSummary } from "../../../src/shared/agent-contracts";
import { makeTempDir, removeTempDir } from "../../helpers/temp-dir";

describe("JsonlThreadStore", () => {
  let userDataDir: string;
  let store: JsonlThreadStore;

  beforeEach(async () => {
    userDataDir = await makeTempDir("agent-thread-store-");
    store = new JsonlThreadStore(userDataDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTempDir(userDataDir);
  });

  it("creates, lists, updates, forks, and deletes thread records", async () => {
    const primary = await store.createThread({
      title: "  Code Review  ",
      workspace: "/workspace",
      mode: "code",
    });
    const side = await store.createThread({
      title: "Side task",
      workspace: "/workspace",
      mode: "code",
      relation: "side",
    });

    expect(primary.title).toBe("Code Review");
    expect(side.relation).toBe("side");
    expect(await store.listThreads()).toHaveLength(1);
    expect(await store.listThreads({ include: ["primary", "side"] })).toHaveLength(2);

    const archived = await store.updateThread(primary.id, {
      status: "archived",
      title: "  Archived review  ",
    });
    expect(archived.status).toBe("archived");
    expect(archived.title).toBe("Archived review");
    expect(await store.listThreads()).toHaveLength(0);
    expect(await store.listThreads({ includeArchived: true })).toHaveLength(1);
    expect(await store.listThreads({ archivedOnly: true })).toHaveLength(1);

    const fork = await store.forkThread(primary.id);
    expect(fork.relation).toBe("fork");
    expect(fork.parentThreadId).toBe(primary.id);
    expect(fork.forkedAt).toBeDefined();

    await store.deleteThread(fork.id);
    expect(await store.getThread(fork.id)).toBeNull();
  });

  it("keeps the index row when thread directory deletion fails so cleanup can be retried", async () => {
    const thread = await store.createThread({
      title: "Retry delete",
      workspace: "/workspace",
      mode: "code",
    });
    const realRm = fs.rm.bind(fs);
    let failNextThreadDelete = true;
    vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (
        failNextThreadDelete &&
        typeof target === "string" &&
        path.basename(target) === thread.id
      ) {
        failNextThreadDelete = false;
        throw new Error("simulated thread directory delete failure");
      }
      return realRm(target, options);
    });

    await expect(store.deleteThread(thread.id)).rejects.toThrow(
      "simulated thread directory delete failure",
    );
    await expect(store.listThreads()).resolves.toEqual([
      expect.objectContaining({ id: thread.id }),
    ]);

    await expect(store.deleteThread(thread.id)).resolves.toBeUndefined();
    await expect(store.listThreads()).resolves.toEqual([]);
    await expect(store.getThread(thread.id)).resolves.toBeNull();
  });

  it("appends and replays items and events while skipping malformed JSONL lines", async () => {
    const thread = await store.createThread({
      workspace: "/workspace",
      mode: "code",
    });
    const item: Item = {
      kind: "user",
      id: "item-1",
      threadId: thread.id,
      turnId: "turn-1",
      text: "Hello",
      createdAt: "2026-06-07T00:00:00.000Z",
    };
    const event: RuntimeEvent = {
      kind: "item_appended",
      threadId: thread.id,
      turnId: "turn-1",
      item,
    };

    await store.appendItem(thread.id, item);
    await fs.appendFile(
      path.join(userDataDir, "threads", thread.id, "messages.jsonl"),
      [
        "{not-json}",
        JSON.stringify({ kind: "assistant", id: "missing-required-fields" }),
        "",
      ].join("\n"),
      "utf8",
    );
    await store.appendEvent(thread.id, event);
    await fs.appendFile(
      path.join(userDataDir, "threads", thread.id, "events.jsonl"),
      [
        JSON.stringify({ kind: "turn_completed", threadId: thread.id }),
        JSON.stringify({
          kind: "turn_completed",
          threadId: thread.id,
          turnId: "turn-1",
          status: "completed",
          completedAt: "2026-06-08T00:00:00.000Z",
          usage: { inputTokens: "8" },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const items: Item[] = [];
      for await (const replayed of store.replayItems(thread.id)) {
        items.push(replayed);
      }
      const events: RuntimeEvent[] = [];
      for await (const replayed of store.replayEvents(thread.id)) {
        events.push(replayed);
      }

      expect(items).toEqual([item]);
      expect(events).toEqual([event]);
      expect(warn).toHaveBeenCalledTimes(4);
    } finally {
      warn.mockRestore();
    }
  });

  it("skips JSONL records owned by a different thread during replay", async () => {
    const thread = await store.createThread({
      workspace: "/workspace",
      mode: "code",
    });
    const otherThread = await store.createThread({
      workspace: "/workspace",
      mode: "code",
    });
    const item: Item = {
      kind: "system",
      id: "item-owned",
      threadId: thread.id,
      turnId: "turn-owned",
      text: "owned",
      level: "info",
      createdAt: "2026-06-07T00:00:00.000Z",
    };
    const foreignItem: Item = {
      ...item,
      id: "item-foreign",
      threadId: otherThread.id,
    };
    const event: RuntimeEvent = {
      kind: "turn_completed",
      threadId: thread.id,
      turnId: "turn-owned",
      status: "completed",
      completedAt: "2026-06-07T00:00:01.000Z",
    };
    const foreignEvent: RuntimeEvent = {
      ...event,
      threadId: otherThread.id,
    };
    const nestedForeignItemEvent: RuntimeEvent = {
      kind: "item_appended",
      threadId: thread.id,
      turnId: "turn-owned",
      item: foreignItem,
    };
    const nestedForeignTurnEvent: RuntimeEvent = {
      kind: "turn_started",
      threadId: thread.id,
      turnId: "turn-foreign",
      startedAt: "2026-06-07T00:00:02.000Z",
      turn: {
        id: "turn-foreign",
        threadId: otherThread.id,
        status: "in-flight",
        startedAt: "2026-06-07T00:00:02.000Z",
        model: "test-model",
        mode: "agent",
      },
    };

    await store.appendItem(thread.id, item);
    await fs.appendFile(
      path.join(userDataDir, "threads", thread.id, "messages.jsonl"),
      `${JSON.stringify(foreignItem)}\n`,
      "utf8",
    );
    await store.appendEvent(thread.id, event);
    await fs.appendFile(
      path.join(userDataDir, "threads", thread.id, "events.jsonl"),
      [
        JSON.stringify(foreignEvent),
        JSON.stringify(nestedForeignItemEvent),
        JSON.stringify(nestedForeignTurnEvent),
        "",
      ].join("\n"),
      "utf8",
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const items: Item[] = [];
      for await (const replayed of store.replayItems(thread.id)) {
        items.push(replayed);
      }
      const events: RuntimeEvent[] = [];
      for await (const replayed of store.replayEvents(thread.id)) {
        events.push(replayed);
      }

      expect(items).toEqual([item]);
      expect(events).toEqual([event]);
      expect(warn).toHaveBeenCalledTimes(4);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("[persistence] skipped malformed messages line"),
        "Invalid messages JSONL record owner.",
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("[persistence] skipped malformed events line"),
        "Invalid events JSONL record owner.",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("updates thread activity time and index order when appending items", async () => {
    const older = await store.createThread({
      title: "Older",
      workspace: "/workspace",
      mode: "code",
    });
    const newer = await store.createThread({
      title: "Newer",
      workspace: "/workspace",
      mode: "code",
    });
    const item: Item = {
      kind: "user",
      id: "item-activity",
      threadId: older.id,
      turnId: "turn-activity",
      text: "activity",
      createdAt: "2099-01-01T00:00:00.000Z",
    };

    await store.appendItem(older.id, item);

    const updated = await store.getThread(older.id);
    const listed = await store.listThreads();
    expect(updated?.updatedAt).toBe(item.createdAt);
    expect(listed[0]).toMatchObject({
      id: older.id,
      updatedAt: item.createdAt,
    });
    expect(listed.map((thread) => thread.id)).toEqual([older.id, newer.id]);
  });

  it("normalizes legacy thread records and summaries with missing safe defaults", async () => {
    const thread = await store.createThread({
      title: "Legacy",
      workspace: "/workspace",
      mode: "code",
    });
    const threadPath = path.join(userDataDir, "threads", thread.id, "thread.json");
    const indexPath = path.join(userDataDir, "threads", "index.json");
    const legacyRecord = JSON.parse(
      await fs.readFile(threadPath, "utf8"),
    ) as Partial<ThreadRecord>;
    const legacyIndex = JSON.parse(
      await fs.readFile(indexPath, "utf8"),
    ) as Array<Partial<ThreadSummary>>;
    delete legacyRecord.mode;
    delete legacyRecord.status;
    delete legacyRecord.approvalPolicy;
    delete legacyRecord.sandboxMode;
    delete legacyIndex[0].mode;
    delete legacyIndex[0].status;
    await fs.writeFile(threadPath, JSON.stringify(legacyRecord, null, 2), "utf8");
    await fs.writeFile(indexPath, JSON.stringify(legacyIndex, null, 2), "utf8");

    await expect(store.getThread(thread.id)).resolves.toMatchObject({
      id: thread.id,
      mode: "code",
      status: "active",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    });
    await expect(store.listThreads()).resolves.toEqual([
      expect.objectContaining({ id: thread.id, mode: "code", status: "active" }),
    ]);
  });

  it("rejects invalid persisted thread policy and summary fields on read", async () => {
    const thread = await store.createThread({
      title: "Bad persisted state",
      workspace: "/workspace",
      mode: "code",
    });
    const threadPath = path.join(userDataDir, "threads", thread.id, "thread.json");
    const indexPath = path.join(userDataDir, "threads", "index.json");
    const record = JSON.parse(await fs.readFile(threadPath, "utf8")) as ThreadRecord;
    const index = JSON.parse(await fs.readFile(indexPath, "utf8")) as ThreadSummary[];

    await fs.writeFile(
      threadPath,
      JSON.stringify({ ...record, approvalPolicy: "sometimes" }, null, 2),
      "utf8",
    );
    await expect(store.getThread(thread.id)).rejects.toThrow("approvalPolicy is invalid.");

    await fs.writeFile(threadPath, JSON.stringify(record, null, 2), "utf8");
    await fs.writeFile(
      threadPath,
      JSON.stringify({ ...record, relation: "fork" }, null, 2),
      "utf8",
    );
    await expect(store.getThread(thread.id)).rejects.toThrow(
      "parentThreadId is required for fork threads.",
    );

    await fs.writeFile(threadPath, JSON.stringify(record, null, 2), "utf8");
    await fs.writeFile(
      threadPath,
      JSON.stringify({ ...record, goal: null }, null, 2),
      "utf8",
    );
    await expect(store.getThread(thread.id)).rejects.toThrow("goal must be an object.");

    await fs.writeFile(threadPath, JSON.stringify(record, null, 2), "utf8");
    await fs.writeFile(
      threadPath,
      JSON.stringify({ ...record, updatedAt: "not-a-date" }, null, 2),
      "utf8",
    );
    await expect(store.getThread(thread.id)).rejects.toThrow(
      "updatedAt must be an ISO timestamp.",
    );

    await fs.writeFile(threadPath, JSON.stringify(record, null, 2), "utf8");
    await fs.writeFile(
      threadPath,
      JSON.stringify({
        ...record,
        goal: {
          text: "Finish",
          status: "active",
          createdAt: "2026-06-07",
          updatedAt: "2026-06-07T00:00:00.000Z",
        },
      }, null, 2),
      "utf8",
    );
    await expect(store.getThread(thread.id)).rejects.toThrow(
      "goal.createdAt must be an ISO timestamp.",
    );

    await fs.writeFile(threadPath, JSON.stringify(record, null, 2), "utf8");
    await fs.writeFile(
      threadPath,
      JSON.stringify({
        ...record,
        goal: {
          text: "Finish",
          status: "active",
          createdAt: "2026-06-07T00:00:00.000Z",
          updatedAt: "2026-06-07T00:00:00.000Z",
          summary: "   ",
        },
      }, null, 2),
      "utf8",
    );
    await expect(store.getThread(thread.id)).rejects.toThrow(
      "goal.summary is required.",
    );

    await fs.writeFile(threadPath, JSON.stringify(record, null, 2), "utf8");
    await fs.writeFile(
      indexPath,
      JSON.stringify([{ ...index[0], status: "paused" }], null, 2),
      "utf8",
    );
    await expect(store.listThreads()).rejects.toThrow("status is invalid.");

    await fs.writeFile(
      indexPath,
      JSON.stringify([{ ...index[0], updatedAt: "not-a-date" }], null, 2),
      "utf8",
    );
    await expect(store.listThreads()).rejects.toThrow(
      "updatedAt must be an ISO timestamp.",
    );
  });

  it("serializes concurrent appends for the same thread", async () => {
    const thread = await store.createThread({
      workspace: "/workspace",
      mode: "code",
    });

    const items = Array.from({ length: 12 }, (_, index): Item => ({
      kind: "system",
      id: `item-${index}`,
      threadId: thread.id,
      turnId: "turn-1",
      text: `message-${index}`,
      level: "info",
      createdAt: "2026-06-07T00:00:00.000Z",
    }));
    await Promise.all(items.map((item) => store.appendItem(thread.id, item)));

    const replayed: Item[] = [];
    for await (const item of store.replayItems(thread.id)) {
      replayed.push(item);
    }
    expect(replayed).toHaveLength(items.length);
    expect(new Set(replayed.map((item) => item.id)).size).toBe(items.length);
  });

  it("rejects invalid item and event records before appending JSONL", async () => {
    const thread = await store.createThread({
      workspace: "/workspace",
      mode: "code",
    });
    const item: Item = {
      kind: "system",
      id: "item-1",
      threadId: thread.id,
      turnId: "turn-1",
      text: "message",
      level: "info",
      createdAt: "2026-06-07T00:00:00.000Z",
    };
    const event: RuntimeEvent = {
      kind: "item_appended",
      threadId: thread.id,
      turnId: "turn-1",
      item,
    };

    await expect(
      store.appendItem(thread.id, { ...item, level: "notice" } as unknown as Item),
    ).rejects.toThrow("Item shape is invalid.");
    await expect(
      store.appendItem(thread.id, { ...item, createdAt: "not-a-date" }),
    ).rejects.toThrow("Item shape is invalid.");
    await expect(
      store.appendItem(thread.id, { ...item, threadId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toThrow("Item threadId does not match target thread.");
    await expect(
      store.appendEvent(thread.id, { ...event, item: { kind: "assistant" } } as unknown as RuntimeEvent),
    ).rejects.toThrow("Runtime event shape is invalid.");
    await expect(
      store.appendEvent(thread.id, {
        kind: "turn_completed",
        threadId: thread.id,
        turnId: "turn-1",
        status: "completed",
        completedAt: "not-a-date",
      }),
    ).rejects.toThrow("Runtime event shape is invalid.");
    await expect(
      store.appendEvent(thread.id, { ...event, threadId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toThrow("Runtime event shape is invalid.");
    await expect(
      store.appendEvent("00000000-0000-4000-8000-000000000000", event),
    ).rejects.toThrow("Runtime event threadId does not match target thread.");
    await expect(
      store.appendEvent(thread.id, {
        ...event,
        item: { ...item, threadId: "00000000-0000-4000-8000-000000000000" },
      }),
    ).rejects.toThrow("Runtime event shape is invalid.");

    const replayedItems: Item[] = [];
    for await (const replayed of store.replayItems(thread.id)) {
      replayedItems.push(replayed);
    }
    const replayedEvents: RuntimeEvent[] = [];
    for await (const replayed of store.replayEvents(thread.id)) {
      replayedEvents.push(replayed);
    }
    expect(replayedItems).toEqual([]);
    expect(replayedEvents).toEqual([]);
  });

  it("rejects non-UUID thread ids before resolving persistence paths", async () => {
    await expect(store.getThread("../outside")).rejects.toThrow("Thread id must be a UUID.");
    await expect(store.deleteThread("../outside")).rejects.toThrow("Thread id must be a UUID.");

    const item: Item = {
      kind: "system",
      id: "item-1",
      threadId: "../outside",
      turnId: "turn-1",
      text: "nope",
      level: "warn",
      createdAt: "2026-06-07T00:00:00.000Z",
    };
    await expect(store.appendItem("../outside", item)).rejects.toThrow(
      "Thread id must be a UUID.",
    );

    const outsidePath = path.join(userDataDir, "outside");
    await fs.writeFile(outsidePath, "do not delete", "utf8");
    await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe("do not delete");
  });

  it("validates thread create, list, and update inputs at runtime", async () => {
    await expect(
      store.createThread({
        workspace: "",
        mode: "code",
      }),
    ).rejects.toThrow("workspace is required.");

    await expect(
      store.createThread({
        workspace: "relative/workspace",
        mode: "code",
      }),
    ).rejects.toThrow("workspace must be an absolute path.");

    await expect(
      store.createThread({
        workspace: "/workspace",
        mode: "invalid" as "code",
      }),
    ).rejects.toThrow("mode is invalid.");

    await expect(
      store.createThread({
        workspace: "/workspace",
        mode: "code",
        relation: "fork",
      }),
    ).rejects.toThrow("parentThreadId is required for fork threads.");

    await expect(store.listThreads({ include: ["primary", "invalid" as "side"] }))
      .rejects.toThrow("include is invalid.");
    await expect(store.listThreads({ includeArchived: "false" as unknown as boolean }))
      .rejects.toThrow("includeArchived must be a boolean.");
    await expect(store.listThreads({ archivedOnly: "true" as unknown as boolean }))
      .rejects.toThrow("archivedOnly must be a boolean.");

    const thread = await store.createThread({
      workspace: "/workspace",
      mode: "code",
      approvalPolicy: "never",
      sandboxMode: "read-only",
    });
    expect(thread).toMatchObject({
      approvalPolicy: "never",
      sandboxMode: "read-only",
    });

    await expect(store.updateThread(thread.id, {})).rejects.toThrow(
      "Thread update patch must include at least one field.",
    );

    await expect(
      store.createThread({
        workspace: "/workspace",
        mode: "code",
        approvalPolicy: "sometimes" as "auto",
      }),
    ).rejects.toThrow("approvalPolicy is invalid.");

    await expect(
      store.createThread({
        workspace: "/workspace",
        mode: "code",
        sandboxMode: "workspace" as "read-only",
      }),
    ).rejects.toThrow("sandboxMode is invalid.");

    await expect(
      store.updateThread(thread.id, {
        approvalPolicy: "sometimes" as "auto",
      }),
    ).rejects.toThrow("approvalPolicy is invalid.");

    await expect(
      store.updateThread(thread.id, {
        goal: {
          text: "Goal",
          status: "waiting" as "active",
          createdAt: "2026-06-07T00:00:00.000Z",
          updatedAt: "2026-06-07T00:00:00.000Z",
        },
      }),
    ).rejects.toThrow("goal.status is invalid.");
  });

  it("removes the new thread directory if indexing the created thread fails", async () => {
    await store.init();
    const indexPath = path.join(userDataDir, "threads", "index.json");
    await fs.rm(indexPath);
    await fs.mkdir(indexPath);

    await expect(
      store.createThread({
        title: "Will fail",
        workspace: "/workspace",
        mode: "code",
      }),
    ).rejects.toThrow();

    const entries = await fs.readdir(path.join(userDataDir, "threads"), {
      withFileTypes: true,
    });
    expect(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
      .toEqual(["index.json"]);
  });
});

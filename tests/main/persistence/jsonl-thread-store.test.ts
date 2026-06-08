import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonlThreadStore } from "../../../src/main/persistence/index";
import type { Item, RuntimeEvent } from "../../../src/shared/agent-contracts";
import { makeTempDir, removeTempDir } from "../../helpers/temp-dir";

describe("JsonlThreadStore", () => {
  let userDataDir: string;
  let store: JsonlThreadStore;

  beforeEach(async () => {
    userDataDir = await makeTempDir("agent-thread-store-");
    store = new JsonlThreadStore(userDataDir);
  });

  afterEach(async () => {
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
      `${JSON.stringify({ kind: "turn_completed", threadId: thread.id })}\n`,
      "utf8",
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
    expect(warn).toHaveBeenCalledTimes(3);
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

    await expect(store.listThreads({ include: ["primary", "invalid" as "side"] }))
      .rejects.toThrow("include is invalid.");
    await expect(store.listThreads({ includeArchived: "false" as unknown as boolean }))
      .rejects.toThrow("includeArchived must be a boolean.");
    await expect(store.listThreads({ archivedOnly: "true" as unknown as boolean }))
      .rejects.toThrow("archivedOnly must be a boolean.");

    const thread = await store.createThread({
      workspace: "/workspace",
      mode: "code",
    });

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

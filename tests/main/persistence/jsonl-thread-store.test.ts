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
      title: "Archived review",
    });
    expect(archived.status).toBe("archived");
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
      "{not-json}\n",
      "utf8",
    );
    await store.appendEvent(thread.id, event);

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
    expect(warn).toHaveBeenCalledOnce();
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
});

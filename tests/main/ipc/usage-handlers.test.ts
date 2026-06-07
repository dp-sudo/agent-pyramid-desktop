import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonlThreadStore } from "../../../src/main/persistence/index";
import {
  collectCachedDailyUsage,
  collectDailyUsage,
} from "../../../src/main/ipc/usage-handlers";
import type { RuntimeEvent } from "../../../src/shared/agent-contracts";
import { makeTempDir, removeTempDir } from "../../helpers/temp-dir";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

describe("usage handlers", () => {
  let userDataDir: string;
  let store: JsonlThreadStore;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-07T12:00:00.000Z"));
    userDataDir = await makeTempDir("agent-usage-store-");
    store = new JsonlThreadStore(userDataDir);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await removeTempDir(userDataDir);
  });

  async function appendCompletedTurnUsage(
    targetStore: JsonlThreadStore,
    totalTokens: number,
  ): Promise<void> {
    const thread = await targetStore.createThread({
      workspace: "/workspace",
      mode: "code",
    });
    const event: RuntimeEvent = {
      kind: "turn_completed",
      threadId: thread.id,
      turnId: "turn-1",
      status: "completed",
      completedAt: "2026-06-07T01:00:00.000Z",
      usage: {
        inputTokens: totalTokens,
        outputTokens: 0,
        totalTokens,
      },
    };
    await targetStore.appendEvent(thread.id, event);
  }

  it("collects daily usage from completed turn events", async () => {
    const thread = await store.createThread({
      workspace: "/workspace",
      mode: "code",
    });
    const event: RuntimeEvent = {
      kind: "turn_completed",
      threadId: thread.id,
      turnId: "turn-1",
      status: "completed",
      completedAt: "2026-06-07T01:00:00.000Z",
      usage: {
        inputTokens: 11,
        outputTokens: 13,
        totalTokens: 24,
        cacheHitTokens: 8,
        cacheMissTokens: 2,
        cacheHitRate: 0.8,
      },
    };
    await store.appendEvent(thread.id, event);

    const buckets = await collectDailyUsage(store, 7);
    const today = buckets.find((bucket) => bucket.date === "2026-06-07");

    expect(today).toMatchObject({
      inputTokens: 11,
      outputTokens: 13,
      totalTokens: 24,
      cacheHitTokens: 8,
      cacheMissTokens: 2,
      cacheHitRate: 0.8,
      turns: 1,
    });
  });

  it("reuses recent usage scans for repeated empty-session heatmap requests", async () => {
    await appendCompletedTurnUsage(store, 8);
    const replayEvents = vi.spyOn(store, "replayEvents");

    const first = await collectCachedDailyUsage(store, 17);
    const second = await collectCachedDailyUsage(store, 17);

    expect(second).toEqual(first);
    expect(replayEvents).toHaveBeenCalledOnce();
  });

  it("keeps usage cache entries isolated per thread store", async () => {
    const otherUserDataDir = await makeTempDir("agent-usage-store-other-");
    const otherStore = new JsonlThreadStore(otherUserDataDir);
    try {
      await appendCompletedTurnUsage(store, 8);
      await appendCompletedTurnUsage(otherStore, 21);

      const first = await collectCachedDailyUsage(store, 17);
      const second = await collectCachedDailyUsage(otherStore, 17);
      const firstToday = first.find((bucket) => bucket.date === "2026-06-07");
      const secondToday = second.find((bucket) => bucket.date === "2026-06-07");

      expect(firstToday?.totalTokens).toBe(8);
      expect(secondToday?.totalTokens).toBe(21);
    } finally {
      await removeTempDir(otherUserDataDir);
    }
  });
});

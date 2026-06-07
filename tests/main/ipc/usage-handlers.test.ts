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
      },
    };
    await store.appendEvent(thread.id, event);

    const buckets = await collectDailyUsage(store, 7);
    const today = buckets.find((bucket) => bucket.date === "2026-06-07");

    expect(today).toMatchObject({
      inputTokens: 11,
      outputTokens: 13,
      totalTokens: 24,
      turns: 1,
    });
  });

  it("reuses recent usage scans for repeated empty-session heatmap requests", async () => {
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
        inputTokens: 3,
        outputTokens: 5,
        totalTokens: 8,
      },
    };
    await store.appendEvent(thread.id, event);
    const replayEvents = vi.spyOn(store, "replayEvents");

    const first = await collectCachedDailyUsage(store, 17);
    const second = await collectCachedDailyUsage(store, 17);

    expect(second).toEqual(first);
    expect(replayEvents).toHaveBeenCalledOnce();
  });
});

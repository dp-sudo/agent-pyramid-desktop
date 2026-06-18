import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UserInputCoordinator } from "../../../src/main/application/user-input-coordinator";
import { RuntimeEventBus } from "../../../src/main/event-bus";
import { JsonlThreadStore } from "../../../src/main/persistence";
import type {
  Item,
  RuntimeEvent,
  ThreadRecord,
  TurnRecord,
  UserInputRespondRequest,
} from "../../../src/shared/agent-contracts";
import { makeTempDir, removeTempDir } from "../../helpers/temp-dir";

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function replayItems(store: JsonlThreadStore, threadId: string): Promise<Item[]> {
  const items: Item[] = [];
  for await (const item of store.replayItems(threadId)) {
    items.push(item);
  }
  return items;
}

function createTurn(thread: ThreadRecord): TurnRecord {
  return {
    id: "turn-1",
    threadId: thread.id,
    status: "in-flight",
    startedAt: "2026-01-01T00:00:00.000Z",
    model: "test-model",
    mode: "agent",
  };
}

describe("UserInputCoordinator", () => {
  let userDataDir: string;
  let store: JsonlThreadStore;
  let bus: RuntimeEventBus;
  let events: RuntimeEvent[];
  let thread: ThreadRecord;
  let turn: TurnRecord;

  beforeEach(async () => {
    userDataDir = await makeTempDir("user-input-coordinator-");
    store = new JsonlThreadStore(userDataDir);
    bus = new RuntimeEventBus();
    events = [];
    for (const kind of ["item_appended", "item_updated", "runtime_error"] as const) {
      bus.on(kind, (event) => events.push(event));
    }
    thread = await store.createThread({
      title: "User input",
      workspace: "/workspace",
      mode: "code",
    });
    turn = createTurn(thread);
  });

  afterEach(async () => {
    await removeTempDir(userDataDir);
  });

  it("appends pending and resolved user input items around a renderer answer", async () => {
    const coordinator = new UserInputCoordinator({ store, bus });
    const response = coordinator.requestUserInput(turn, {
      question: "Which file should I edit?",
      options: ["README.md", "docs/guide.md"],
    });
    await waitFor(() => events.some((event) => event.kind === "item_appended"));

    const pendingItem = (await replayItems(store, thread.id))
      .find((item): item is Extract<Item, { kind: "user_input" }> => item.kind === "user_input");
    if (!pendingItem?.userInputId) {
      throw new Error("Expected pending user input item.");
    }

    expect(coordinator.respond({
      userInputId: pendingItem.userInputId,
      answer: " docs/guide.md ",
    })).toEqual({
      userInputId: pendingItem.userInputId,
      accepted: true,
      answer: "docs/guide.md",
    });
    await expect(response).resolves.toEqual({ answer: "docs/guide.md" });

    const inputItems = (await replayItems(store, thread.id))
      .filter((item) => item.kind === "user_input");
    expect(inputItems).toHaveLength(2);
    expect(inputItems[1]).toMatchObject({
      userInputId: pendingItem.userInputId,
      answer: "docs/guide.md",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "item_updated" }),
      ]),
    );
  });

  it("cancels pending user input requests for an interrupted turn", async () => {
    const coordinator = new UserInputCoordinator({ store, bus });
    const response = coordinator.requestUserInput(turn, {
      question: "Continue?",
    });
    await waitFor(() => events.some((event) => event.kind === "item_appended"));

    await coordinator.resolvePendingForTurn(turn.id);
    await expect(response).resolves.toEqual({ cancelled: true });

    const inputItems = (await replayItems(store, thread.id))
      .filter((item) => item.kind === "user_input");
    expect(inputItems[1]).toMatchObject({ cancelled: true });
  });

  it("returns a stable response for invalid or stale user input responses", () => {
    const coordinator = new UserInputCoordinator({ store, bus });

    expect(coordinator.respond({ userInputId: "missing", cancelled: true })).toEqual({
      userInputId: "missing",
      accepted: false,
      cancelled: true,
      reason: "not_pending",
    });

    const invalidResponse = {
      userInputId: "missing",
      answer: " ",
    } as unknown as UserInputRespondRequest;
    expect(() => coordinator.respond(invalidResponse)).toThrow(
      "User input response requires a non-empty answer or cancelled=true.",
    );
  });
});

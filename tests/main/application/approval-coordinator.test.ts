import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalCoordinator } from "../../../src/main/application/approval-coordinator";
import { RuntimeEventBus } from "../../../src/main/event-bus";
import { JsonlThreadStore } from "../../../src/main/persistence";
import type { AgentToolCall } from "../../../src/main/domain/agent/types";
import type {
  ApprovalRespondRequest,
  Item,
  RuntimeEvent,
  ThreadRecord,
  TurnRecord,
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

function createCall(name = "write_file"): AgentToolCall {
  return {
    id: `call-${name}`,
    name,
    arguments: { path: "draft.md", content: "draft" },
  };
}

describe("ApprovalCoordinator", () => {
  let userDataDir: string;
  let store: JsonlThreadStore;
  let bus: RuntimeEventBus;
  let events: RuntimeEvent[];
  let thread: ThreadRecord;
  let turn: TurnRecord;

  beforeEach(async () => {
    userDataDir = await makeTempDir("approval-coordinator-");
    store = new JsonlThreadStore(userDataDir);
    bus = new RuntimeEventBus();
    events = [];
    for (const kind of ["item_appended", "item_updated", "approval_requested", "runtime_error"] as const) {
      bus.on(kind, (event) => events.push(event));
    }
    thread = await store.createThread({
      title: "Approvals",
      workspace: "/workspace",
      mode: "code",
    });
    turn = createTurn(thread);
  });

  afterEach(async () => {
    await removeTempDir(userDataDir);
  });

  it("appends pending and resolved approval items around a user decision", async () => {
    const coordinator = new ApprovalCoordinator({
      store,
      bus,
      async previewProvider() {
        return {
          kind: "file_diff",
          path: "draft.md",
          operation: "update",
          added: 1,
          removed: 0,
          lines: [{ type: "added", text: "draft" }],
        };
      },
    });
    const decision = coordinator.requestApproval(turn, createCall(), thread);
    await waitFor(() => events.some((event) => event.kind === "approval_requested"));

    const requestEvent = events.find((event) => event.kind === "approval_requested");
    if (!requestEvent || requestEvent.kind !== "approval_requested") {
      throw new Error("Expected approval request event.");
    }
    expect(requestEvent.preview).toMatchObject({
      kind: "file_diff",
      path: "draft.md",
    });
    expect((await replayItems(store, thread.id)).filter((item) => item.kind === "approval")).toHaveLength(1);

    coordinator.respond({ approvalId: requestEvent.approvalId, decision: "allow" });
    await expect(decision).resolves.toBe("allow");

    const approvalItems = (await replayItems(store, thread.id)).filter((item) => item.kind === "approval");
    expect(approvalItems).toHaveLength(2);
    expect(approvalItems[1]).toMatchObject({
      approvalId: requestEvent.approvalId,
      decision: "allow",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "item_updated" }),
      ]),
    );
  });

  it("denies pending approvals for an interrupted turn", async () => {
    const coordinator = new ApprovalCoordinator({
      store,
      bus,
      async previewProvider() {
        return undefined;
      },
    });
    const decision = coordinator.requestApproval(turn, createCall("run_command"), thread);
    await waitFor(() => events.some((event) => event.kind === "approval_requested"));

    await coordinator.resolvePendingForTurn(turn.id, "deny");
    await expect(decision).resolves.toBe("deny");

    const approvalItems = (await replayItems(store, thread.id)).filter((item) => item.kind === "approval");
    expect(approvalItems[1]).toMatchObject({ decision: "deny" });
  });

  it("rejects invalid or stale approval responses", () => {
    const coordinator = new ApprovalCoordinator({
      store,
      bus,
      async previewProvider() {
        return undefined;
      },
    });

    expect(() =>
      coordinator.respond({ approvalId: "missing", decision: "allow" }),
    ).toThrow("Approval missing is not pending.");

    const invalidDecision = {
      approvalId: "missing",
      decision: "approve",
    } as unknown as ApprovalRespondRequest;
    expect(() => coordinator.respond(invalidDecision)).toThrow(
      "Approval decision must be allow or deny.",
    );
  });
});

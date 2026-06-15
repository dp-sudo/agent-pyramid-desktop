import { randomUUID } from "node:crypto";
import type { AgentToolCall } from "../domain/agent/types.js";
import { JsonlThreadStore } from "../persistence/index.js";
import { RuntimeEventBus } from "../event-bus.js";
import type {
  ApprovalDecisionScope,
  ApprovalItem,
  ApprovalRespondRequest,
  ThreadRecord,
  TurnRecord,
} from "../../shared/agent-contracts.js";

type ApprovalDecision = "allow" | "deny";
type ApprovalResolution = { decision: ApprovalDecision; scope: ApprovalDecisionScope };

interface PendingApproval {
  approvalId: string;
  threadId: string;
  turnId: string;
  toolName: string;
  args: Record<string, unknown>;
  preview?: ApprovalItem["preview"];
  resolve: (resolution: ApprovalResolution) => Promise<void>;
}

export interface ApprovalCoordinatorDeps {
  store: JsonlThreadStore;
  bus: RuntimeEventBus;
  previewProvider: (
    call: AgentToolCall,
    turn: TurnRecord,
    thread: ThreadRecord,
  ) => Promise<ApprovalItem["preview"] | undefined>;
}

export class ApprovalCoordinator {
  private readonly pendingApprovals = new Map<string, PendingApproval>();

  constructor(private readonly deps: ApprovalCoordinatorDeps) {}

  respond(approval: ApprovalRespondRequest): void {
    if (approval.decision !== "allow" && approval.decision !== "deny") {
      throw new Error("Approval decision must be allow or deny.");
    }
    const pending = this.pendingApprovals.get(approval.approvalId);
    if (!pending) {
      throw new Error(`Approval ${approval.approvalId} is not pending.`);
    }
    void pending.resolve({
      decision: approval.decision,
      scope: approval.scope ?? "once",
    });
    this.pendingApprovals.delete(approval.approvalId);
  }

  /**
   * Appends the pending approval item and emits the live request event before
   * suspending tool execution. The resolved item is appended later for timeline
   * auditability, while the in-memory map remains non-persistent by design.
   */
  async requestApproval(
    turn: TurnRecord,
    call: AgentToolCall,
    thread: ThreadRecord,
  ): Promise<ApprovalResolution> {
    const approvalId = randomUUID();
    const preview = await this.deps.previewProvider(call, turn, thread);
    const pendingItem: ApprovalItem = {
      kind: "approval",
      id: randomUUID(),
      threadId: turn.threadId,
      turnId: turn.id,
      approvalId,
      toolName: call.name,
      args: call.arguments,
      ...(preview ? { preview } : {}),
      createdAt: new Date().toISOString(),
    };
    await this.deps.store.appendItem(turn.threadId, pendingItem);
    this.deps.bus.emit("item_appended", {
      kind: "item_appended",
      threadId: turn.threadId,
      turnId: turn.id,
      item: pendingItem,
    });

    return new Promise<ApprovalResolution>((resolve) => {
      this.pendingApprovals.set(approvalId, {
        approvalId,
        threadId: turn.threadId,
        turnId: turn.id,
        toolName: call.name,
        args: call.arguments,
        ...(preview ? { preview } : {}),
        resolve: async (resolution) => {
          await this.resolveApproval(pendingItem, resolution);
          resolve(resolution);
        },
      });
      this.deps.bus.emit("approval_requested", {
        kind: "approval_requested",
        threadId: turn.threadId,
        turnId: turn.id,
        approvalId,
        toolName: call.name,
        args: call.arguments,
        ...(preview ? { preview } : {}),
      });
    });
  }

  async resolvePendingForTurn(turnId: string, decision: ApprovalDecision): Promise<void> {
    const pendingForTurn: PendingApproval[] = [];
    for (const [approvalId, pending] of this.pendingApprovals) {
      if (pending.turnId !== turnId) continue;
      pendingForTurn.push(pending);
      this.pendingApprovals.delete(approvalId);
    }
    await Promise.all(pendingForTurn.map((pending) =>
      pending.resolve({ decision, scope: "once" })
    ));
  }

  private async resolveApproval(
    pendingItem: ApprovalItem,
    resolution: ApprovalResolution,
  ): Promise<void> {
    const item: ApprovalItem = {
      ...pendingItem,
      kind: "approval",
      decision: resolution.decision,
      scope: resolution.scope,
      resolvedAt: new Date().toISOString(),
    };
    try {
      await this.deps.store.appendItem(pendingItem.threadId, item);
    } catch (error) {
      this.deps.bus.emit("runtime_error", {
        kind: "runtime_error",
        threadId: pendingItem.threadId,
        turnId: pendingItem.turnId,
        code: "persistence_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    this.deps.bus.emit("item_updated", {
      kind: "item_updated",
      threadId: pendingItem.threadId,
      turnId: pendingItem.turnId,
      item,
    });
  }
}

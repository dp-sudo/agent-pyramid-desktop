import { randomUUID } from "node:crypto";
import { RuntimeEventBus } from "../event-bus.js";
import { JsonlThreadStore } from "../persistence/index.js";
import type {
  TurnRecord,
  UserInputItem,
  UserInputRespondRequest,
  UserInputRespondResponse,
} from "../../shared/agent-contracts.js";

interface UserInputRequest {
  question: string;
  options?: string[];
}

type UserInputResolution =
  | { answer: string; cancelled?: false }
  | { cancelled: true };

interface PendingUserInput {
  item: UserInputItem;
  resolve: (resolution: UserInputResolution) => Promise<void>;
}

export interface UserInputCoordinatorDeps {
  store: JsonlThreadStore;
  bus: RuntimeEventBus;
}

/**
 * Coordinates model-initiated questions that must pause the turn until the
 * renderer answers. Approval remains a separate gate; this seam is for missing
 * task information, so the model can ask instead of guessing.
 */
export class UserInputCoordinator {
  private readonly pendingInputs = new Map<string, PendingUserInput>();

  constructor(private readonly deps: UserInputCoordinatorDeps) {}

  respond(request: UserInputRespondRequest): UserInputRespondResponse {
    const resolution = normalizeUserInputResolution(request);
    const pending = this.pendingInputs.get(request.userInputId);
    if (!pending) {
      return {
        userInputId: request.userInputId,
        accepted: false,
        reason: "not_pending",
        ...resolution,
      };
    }
    void pending.resolve(resolution);
    this.pendingInputs.delete(request.userInputId);
    return {
      userInputId: request.userInputId,
      accepted: true,
      ...resolution,
    };
  }

  async requestUserInput(
    turn: TurnRecord,
    request: UserInputRequest,
  ): Promise<UserInputResolution> {
    const userInputId = randomUUID();
    const pendingItem: UserInputItem = {
      kind: "user_input",
      id: randomUUID(),
      threadId: turn.threadId,
      turnId: turn.id,
      userInputId,
      question: request.question,
      ...(request.options && request.options.length > 0 ? { options: request.options } : {}),
      createdAt: new Date().toISOString(),
    };
    await this.deps.store.appendItem(turn.threadId, pendingItem);
    this.deps.bus.emit("item_appended", {
      kind: "item_appended",
      threadId: turn.threadId,
      turnId: turn.id,
      item: pendingItem,
    });

    return new Promise<UserInputResolution>((resolve) => {
      this.pendingInputs.set(userInputId, {
        item: pendingItem,
        resolve: async (resolution) => {
          await this.resolveUserInput(pendingItem, resolution);
          resolve(resolution);
        },
      });
    });
  }

  async resolvePendingForTurn(turnId: string): Promise<void> {
    const pendingForTurn: PendingUserInput[] = [];
    for (const [userInputId, pending] of this.pendingInputs) {
      if (pending.item.turnId !== turnId) continue;
      pendingForTurn.push(pending);
      this.pendingInputs.delete(userInputId);
    }
    await Promise.all(
      pendingForTurn.map((pending) => pending.resolve({ cancelled: true })),
    );
  }

  private async resolveUserInput(
    pendingItem: UserInputItem,
    resolution: UserInputResolution,
  ): Promise<void> {
    const item: UserInputItem = {
      ...pendingItem,
      ...(resolution.cancelled ? { cancelled: true } : { answer: resolution.answer }),
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

function normalizeUserInputResolution(
  request: UserInputRespondRequest,
): UserInputResolution {
  if (request.cancelled === true) {
    return { cancelled: true };
  }
  if (typeof request.answer !== "string" || !request.answer.trim()) {
    throw new Error("User input response requires a non-empty answer or cancelled=true.");
  }
  return { answer: request.answer.trim() };
}

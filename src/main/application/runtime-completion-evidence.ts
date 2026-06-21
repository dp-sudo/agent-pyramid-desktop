import type { CheckpointStore } from "../persistence/checkpoint-store.js";
import type {
  Item,
  RuntimeErrorEvent,
  TurnRecord,
} from "../../shared/agent-contracts.js";
import {
  buildTurnCompletionEvidenceText,
  type CompletionEvidenceCheckpointState,
} from "./completion-evidence.js";

export interface RuntimeCompletionEvidenceDeps {
  store: {
    replayItems(threadId: string): AsyncIterable<Item>;
  };
  checkpointStore?: Pick<CheckpointStore, "list">;
  reportRuntimeError(
    turn: TurnRecord,
    code: RuntimeErrorEvent["code"],
    message: string,
    error?: unknown,
  ): void;
}

export async function buildRuntimeCompletionEvidenceText(
  deps: RuntimeCompletionEvidenceDeps,
  turn: TurnRecord,
): Promise<string | null> {
  const items = await replayTurnItems(deps.store, turn);
  return buildTurnCompletionEvidenceText({
    items,
    checkpointState: await resolveCompletionEvidenceCheckpointState(deps, turn),
  });
}

async function replayTurnItems(
  store: RuntimeCompletionEvidenceDeps["store"],
  turn: TurnRecord,
): Promise<Item[]> {
  const items: Item[] = [];
  for await (const item of store.replayItems(turn.threadId)) {
    if ("turnId" in item && item.turnId === turn.id) {
      items.push(item);
    }
  }
  return items;
}

async function resolveCompletionEvidenceCheckpointState(
  deps: RuntimeCompletionEvidenceDeps,
  turn: TurnRecord,
): Promise<CompletionEvidenceCheckpointState> {
  if (!deps.checkpointStore) {
    return { kind: "not_configured" };
  }
  try {
    const checkpoints = await deps.checkpointStore.list(turn.threadId);
    const checkpoint = checkpoints.find((candidate) => candidate.turnId === turn.id);
    return {
      kind: "available",
      paths: checkpoint?.files.map((file) => file.path) ?? [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.reportRuntimeError(
      turn,
      "persistence_error",
      `Completion evidence checkpoint lookup failed: ${message}`,
      error,
    );
    return { kind: "lookup_failed", message };
  }
}

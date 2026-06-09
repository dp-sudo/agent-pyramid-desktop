import { ipcMain } from "electron";
import {
  TURN_START_CHANNEL,
  TURN_INTERRUPT_CHANNEL,
  TURN_GET_CHANNEL,
} from "../../shared/ipc.js";
import type {
  TurnStartRequest,
  Item,
} from "../../shared/agent-contracts.js";
import { err, ok } from "../../shared/agent-contracts.js";
import type { AgentRuntime } from "../application/agent-runtime.js";
import type { JsonlThreadStore } from "../persistence/index.js";

export function registerTurnHandlers(
  runtime: AgentRuntime,
  store: JsonlThreadStore,
): void {
  ipcMain.handle(TURN_START_CHANNEL, async (_event, request: TurnStartRequest) => {
    try {
      return ok(await runtime.startTurn(request));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message === "RUNTIME_TURN_BUSY" ? "RUNTIME_TURN_BUSY" : "TURN_START_FAILED";
      return err(code, message);
    }
  });

  ipcMain.handle(
    TURN_INTERRUPT_CHANNEL,
    async (_event, request: unknown) => {
      try {
        const turnId = parseTurnInterruptRequest(request);
        await runtime.interruptTurn(turnId);
        return ok({ turnId });
      } catch (error) {
        return err("TURN_INTERRUPT_FAILED", messageOf(error));
      }
    },
  );

  ipcMain.handle(TURN_GET_CHANNEL, async (_event, request: unknown) => {
    try {
      const threadId = parseTurnGetRequest(request);
      const byId = new Map<string, Item>();
      for await (const item of store.replayItems(threadId)) {
        byId.set(item.id, item);
      }
      const items = [...byId.values()];
      return ok({ threadId, items });
    } catch (error) {
      return err("TURN_GET_FAILED", messageOf(error));
    }
  });
}

// Interrupt is a renderer IPC boundary: malformed payloads must fail visibly
// instead of being treated as a no-op successful interrupt.
export function parseTurnInterruptRequest(request: unknown): string {
  if (typeof request !== "string" || !request.trim()) {
    throw new Error("Turn interrupt requires a turnId string.");
  }
  return request.trim();
}

export function parseTurnGetRequest(request: unknown): string {
  if (typeof request !== "string" || !request.trim()) {
    throw new Error("Turn get requires a threadId string.");
  }
  return request.trim();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

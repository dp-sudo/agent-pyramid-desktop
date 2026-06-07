import { parentPort } from "node:worker_threads";
import { MiniMaxGateway } from "../minimax/minimax-gateway.js";
import type {
  WorkerChatRequest,
  WorkerInbound,
  WorkerOutbound,
} from "./protocol.js";
import type { LlmRequest, LlmResponse } from "../../domain/agent/types.js";

if (!parentPort) {
  throw new Error("llm-worker must be launched as a worker_thread.");
}

const gateway = new MiniMaxGateway();
const inflight = new Map<string, AbortController>();

function send(message: WorkerOutbound): void {
  parentPort!.postMessage(message);
}

async function handleChat(request: WorkerChatRequest): Promise<void> {
  const { requestId, payload } = request;
  const controller = new AbortController();
  inflight.set(requestId, controller);
  try {
    // The current MiniMax gateway does not yet accept an AbortSignal.
    // The controller is plumbed here so the cancellation path is exercised
    // end-to-end; the gateway can adopt it in a follow-up.
    void controller.signal;
    const response: LlmResponse = await gateway.complete(payload as LlmRequest);
    send({ kind: "done", response });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send({ kind: "error", message, code: "internal" });
  } finally {
    inflight.delete(requestId);
  }
}

function handleCancel(requestId: string): void {
  const controller = inflight.get(requestId);
  if (controller) {
    controller.abort();
    inflight.delete(requestId);
  }
}

parentPort.on("message", (raw: WorkerInbound) => {
  switch (raw.type) {
    case "chat":
      void handleChat(raw as WorkerChatRequest);
      return;
    case "cancel":
      handleCancel(raw.requestId);
      return;
    default: {
      const exhaustive: never = raw;
      void exhaustive;
    }
  }
});

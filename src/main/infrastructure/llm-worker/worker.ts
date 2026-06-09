import { parentPort } from "node:worker_threads";
import { MiniMaxGateway } from "../minimax/minimax-gateway.js";
import {
  classifyWorkerErrorCode,
  createWorkerRawStreamSummary,
  normalizeWorkerErrorCode,
  recordWorkerRawStreamChunk,
} from "./worker-diagnostics.js";
import type {
  WorkerChatRequest,
  WorkerInbound,
  WorkerOutbound,
} from "./protocol.js";
import type { AgentToolCall, AgentUsage, LlmRequest, LlmResponse } from "../../domain/agent/types.js";

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
    let text = "";
    let reasoning = "";
    let usage: AgentUsage | undefined;
    const toolCalls: AgentToolCall[] = [];
    const rawSummary = createWorkerRawStreamSummary();

    for await (const chunk of gateway.stream(payload as LlmRequest, { signal: controller.signal })) {
      recordWorkerRawStreamChunk(rawSummary, chunk);
      if (chunk.kind === "text_delta") {
        text += chunk.text;
        send({ kind: "delta", requestId, chunk });
      } else if (chunk.kind === "reasoning_delta") {
        reasoning += chunk.text;
        send({ kind: "delta", requestId, chunk });
      } else if (chunk.kind === "tool_call_delta") {
        send({ kind: "delta", requestId, chunk });
      } else if (chunk.kind === "tool_call_completed") {
        toolCalls.push(chunk.toolCall);
        send({ kind: "delta", requestId, chunk });
      } else if (chunk.kind === "usage") {
        usage = chunk.usage;
        send({ kind: "delta", requestId, chunk });
      } else if (chunk.kind === "completed") {
        send({ kind: "delta", requestId, chunk });
      } else if (chunk.kind === "error") {
        send({
          kind: "error",
          requestId,
          message: chunk.message,
          code: normalizeWorkerErrorCode(chunk.code),
        });
        return;
      }
    }

    const response: LlmResponse = {
      text,
      reasoning,
      toolCalls,
      usage,
      raw: rawSummary
    };
    send({ kind: "done", requestId, response });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send({ kind: "error", requestId, message, code: classifyWorkerErrorCode(error) });
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

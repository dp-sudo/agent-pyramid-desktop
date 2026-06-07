import type { LlmRequest, LlmResponse } from "../../domain/agent/types.js";
import type { LlmProtocol } from "../../../shared/agent-contracts.js";

/** A chunk emitted while the model is streaming a chat completion. */
export interface StreamChunk {
  kind: "delta";
  text: string;
  reasoning?: string;
}

/** Final message for a chat invocation. */
export interface StreamDone {
  kind: "done";
  response: LlmResponse;
}

/** Worker errored; main process should mark turn failed. */
export interface StreamError {
  kind: "error";
  message: string;
  code?: "http" | "schema" | "internal";
}

export type WorkerOutbound = StreamChunk | StreamDone | StreamError;

/** Renderer/agent code asks the worker to run one chat completion. */
export interface WorkerChatRequest {
  type: "chat";
  requestId: string;
  payload: LlmRequest;
}

export interface WorkerCancelMessage {
  type: "cancel";
  requestId: string;
}

export type WorkerInbound = WorkerChatRequest | WorkerCancelMessage;

/** Minimal echo of an inbound request — useful for trace logs. */
export function describeProtocol(protocol: LlmProtocol): string {
  return protocol === "openai-compatible" ? "openai" : "anthropic";
}

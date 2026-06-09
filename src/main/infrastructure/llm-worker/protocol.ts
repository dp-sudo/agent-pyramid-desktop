import type { LlmRequest, LlmResponse, LlmStreamChunk } from "../../domain/agent/types.js";

export type WorkerErrorCode = "http" | "provider" | "schema" | "internal";

/** A chunk emitted while the model is streaming a chat completion. */
export interface StreamChunk {
  kind: "delta";
  requestId: string;
  chunk: LlmStreamChunk;
}

/** Final message for a chat invocation. */
export interface StreamDone {
  kind: "done";
  requestId: string;
  response: LlmResponse;
}

/** Worker errored; main process should mark turn failed. */
export interface StreamError {
  kind: "error";
  requestId: string;
  message: string;
  code?: WorkerErrorCode;
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

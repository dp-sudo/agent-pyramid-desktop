import type {
  AgentToolCall,
  AgentUsage,
  LlmStopReason,
  LlmStreamChunk,
} from "../../domain/agent/types.js";
import type { WorkerErrorCode } from "./protocol.js";

const RAW_STREAM_SAMPLE_LIMIT = 50;

export type WorkerRawStreamSample =
  | { kind: "text_delta"; textLength: number }
  | { kind: "reasoning_delta"; textLength: number }
  | {
      kind: "tool_call_delta";
      toolCallId: string;
      name?: string;
      argumentsDeltaLength?: number;
    }
  | { kind: "tool_call_completed"; toolCall: AgentToolCall }
  | { kind: "usage"; usage: AgentUsage }
  | { kind: "completed"; stopReason: LlmStopReason }
  | { kind: "error"; message: string; code?: string };

export interface WorkerRawStreamSummary {
  kind: "stream_summary";
  chunkCount: number;
  sampleLimit: number;
  samples: WorkerRawStreamSample[];
  truncatedSamples: number;
}

export function createWorkerRawStreamSummary(): WorkerRawStreamSummary {
  return {
    kind: "stream_summary",
    chunkCount: 0,
    sampleLimit: RAW_STREAM_SAMPLE_LIMIT,
    samples: [],
    truncatedSamples: 0,
  };
}

export function recordWorkerRawStreamChunk(
  summary: WorkerRawStreamSummary,
  chunk: LlmStreamChunk,
): void {
  summary.chunkCount += 1;
  if (summary.samples.length >= summary.sampleLimit) {
    summary.truncatedSamples += 1;
    return;
  }
  summary.samples.push(toWorkerRawStreamSample(chunk));
}

export function normalizeWorkerErrorCode(value: unknown): WorkerErrorCode {
  return value === "http" || value === "provider" || value === "schema" || value === "internal"
    ? value
    : "internal";
}

export function classifyWorkerErrorCode(error: unknown): WorkerErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  if (/^LLM .+ (request|stream) failed with HTTP \d+:/u.test(message)) {
    return "http";
  }
  if (message.startsWith("LLM stream error event:")) {
    return "provider";
  }
  if (
    message.includes("response was not valid JSON") ||
    message.includes("stream frame was not valid JSON") ||
    message.startsWith("Failed to parse arguments for tool") ||
    message.includes("is missing a tool name.")
  ) {
    return "schema";
  }
  return "internal";
}

function toWorkerRawStreamSample(chunk: LlmStreamChunk): WorkerRawStreamSample {
  switch (chunk.kind) {
    case "text_delta":
      return { kind: "text_delta", textLength: chunk.text.length };
    case "reasoning_delta":
      return { kind: "reasoning_delta", textLength: chunk.text.length };
    case "tool_call_delta":
      return {
        kind: "tool_call_delta",
        toolCallId: chunk.toolCallId,
        ...(chunk.name ? { name: chunk.name } : {}),
        ...(chunk.argumentsDelta
          ? { argumentsDeltaLength: chunk.argumentsDelta.length }
          : {}),
      };
    case "tool_call_completed":
      return { kind: "tool_call_completed", toolCall: chunk.toolCall };
    case "usage":
      return { kind: "usage", usage: chunk.usage };
    case "completed":
      return { kind: "completed", stopReason: chunk.stopReason };
    case "error":
      return {
        kind: "error",
        message: chunk.message,
        ...(chunk.code ? { code: chunk.code } : {}),
      };
    default: {
      const exhaustive: never = chunk;
      return exhaustive;
    }
  }
}

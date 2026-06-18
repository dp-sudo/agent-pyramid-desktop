import { redactSecrets } from "./gateway-common.js";

/**
 * Protocol-agnostic SSE stream decoder for LLM gateway responses.
 *
 * These functions were extracted from MiniMaxGateway so the SSE wire format
 * (frame splitting, event/data parsing, error-event detection) is testable in
 * isolation and reusable across OpenAI-compatible and Anthropic-compatible
 * transports. They hold no gateway-specific state — only pure byte→payload
 * decoding over a ReadableStream.
 */

/** Yield parsed JSON payloads from an SSE response body until [DONE] or abort. */
export async function* readSseJson(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): AsyncIterable<unknown> {
  if (!body) {
    throw new Error("SSE response body is missing.");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let frame: { block: string; rest: string } | null;
      while ((frame = takeSseFrame(buffer)) !== null) {
        buffer = frame.rest;
        const payload = parseSseFrame(frame.block);
        if (payload === null) continue;
        if (payload === "[DONE]") return;
        yield payload;
      }
    }

    buffer += decoder.decode();
    const trailing = buffer.trim();
    if (trailing && !signal?.aborted) {
      const payload = parseSseFrame(trailing);
      if (payload !== null && payload !== "[DONE]") {
        yield payload;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch (error) {
      console.warn("[minimax] failed to release SSE reader lock:", error);
    }
  }
}

/** Split the first complete SSE frame (delimited by blank line) from the buffer. */
export function takeSseFrame(buffer: string): { block: string; rest: string } | null {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return {
      block: buffer.slice(0, crlf),
      rest: buffer.slice(crlf + 4),
    };
  }
  return {
    block: buffer.slice(0, lf),
    rest: buffer.slice(lf + 2),
  };
}

/** Parse a single SSE frame into a JSON payload, "[DONE]", null (skip), or throw on error events. */
export function parseSseFrame(frame: string): unknown | "[DONE]" | null {
  const lines = frame
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const event = lines
    .filter((line) => line.startsWith("event:"))
    .map((line) => line.slice(6).trim())
    .find((value) => value.length > 0);
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();

  if (!data) return null;
  if (data === "[DONE]") return "[DONE]";

  if (event === "error") {
    throw new Error(`LLM stream error event: ${formatSseErrorData(data)}`);
  }

  try {
    return JSON.parse(data) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`LLM stream frame was not valid JSON: ${reason}`);
  }
}

/** Extract a human-readable summary from an SSE error-event data payload. */
export function formatSseErrorData(data: string): string {
  const safeData = redactSecrets(data);
  try {
    const parsed = JSON.parse(safeData) as unknown;
    if (parsed && typeof parsed === "object") {
      const value = parsed as {
        error?: { message?: unknown; type?: unknown; code?: unknown };
        message?: unknown;
      };
      const message =
        typeof value.error?.message === "string"
          ? value.error.message
          : typeof value.message === "string" ? value.message : "";
      const type = typeof value.error?.type === "string" ? value.error.type : "";
      const code =
        typeof value.error?.code === "string" || typeof value.error?.code === "number"
          ? String(value.error.code)
          : "";
      const details = [type, code, message].filter((part) => part.length > 0).join(": ");
      return redactSecrets(details || JSON.stringify(parsed)).slice(0, 800);
    }
  } catch (error) {
    void error;
    return safeData.slice(0, 800);
  }
  return safeData.slice(0, 800);
}

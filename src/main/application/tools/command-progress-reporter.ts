import { StringDecoder } from "node:string_decoder";
import type { AgentCommandToolContext } from "../../domain/agent/types.js";

const TOOL_PROGRESS_FLUSH_INTERVAL_MS = 100;
const TOOL_PROGRESS_FLUSH_THRESHOLD_BYTES = 8 * 1024;
const TOOL_PROGRESS_MAX_CHUNK_CHARS = 16 * 1024;

export type ToolProgressCallback = NonNullable<AgentCommandToolContext["reportProgress"]>;
export type CommandProgressStream = Parameters<ToolProgressCallback>[1];

export interface CommandProgressReporter {
  collect(data: Buffer | string, stream: CommandProgressStream): void;
  flush(): void;
}

export function createCommandProgressReporter(
  reportProgress: ToolProgressCallback | undefined,
): CommandProgressReporter | undefined {
  if (!reportProgress) return undefined;
  const pending: Record<CommandProgressStream, string> = {
    stdout: "",
    stderr: "",
  };
  const pendingBytes: Record<CommandProgressStream, number> = {
    stdout: 0,
    stderr: 0,
  };
  const decoders: Record<CommandProgressStream, StringDecoder> = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  };
  let flushTimer: NodeJS.Timeout | undefined;
  let warned = false;

  const clearFlushTimer = (): void => {
    if (!flushTimer) return;
    clearTimeout(flushTimer);
    flushTimer = undefined;
  };

  const reportChunk = (chunk: string, stream: CommandProgressStream): void => {
    for (let index = 0; index < chunk.length; index += TOOL_PROGRESS_MAX_CHUNK_CHARS) {
      const slice = chunk.slice(index, index + TOOL_PROGRESS_MAX_CHUNK_CHARS);
      if (!slice) continue;
      try {
        reportProgress(slice, stream);
      } catch (error) {
        if (!warned) {
          warned = true;
          console.warn("[command-tools] failed to report command progress:", error);
        }
      }
    }
  };

  const flushStream = (stream: CommandProgressStream, final: boolean): void => {
    const text = pending[stream] + (final ? decoders[stream].end() : "");
    pending[stream] = "";
    pendingBytes[stream] = 0;
    if (text) {
      reportChunk(text, stream);
    }
  };

  const flushPending = (final = false): void => {
    clearFlushTimer();
    flushStream("stdout", final);
    flushStream("stderr", final);
  };

  const scheduleFlush = (): void => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushPending();
    }, TOOL_PROGRESS_FLUSH_INTERVAL_MS);
  };

  return {
    collect(data, stream) {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const text = decoders[stream].write(buffer);
      if (!text) return;
      pending[stream] += text;
      pendingBytes[stream] += buffer.length;
      if (pendingBytes[stream] >= TOOL_PROGRESS_FLUSH_THRESHOLD_BYTES) {
        flushPending();
        return;
      }
      scheduleFlush();
    },
    flush() {
      flushPending(true);
    },
  };
}

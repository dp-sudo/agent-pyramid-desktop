import type { Item, ToolProgressEvent } from "../../../../shared/agent-contracts";

const TOOL_PROGRESS_DISPLAY_MAX_CHARS = 12_000;

export interface ToolProgressDisplayResult {
  kind: "tool_progress";
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export type ToolProgressUpdate = Pick<
  ToolProgressEvent,
  "threadId" | "turnId" | "toolCallId" | "seq"
> & {
  stdout?: string;
  stderr?: string;
};

export function toolProgressBufferKey(event: ToolProgressEvent): string {
  return `${event.threadId}:${event.turnId}:${event.toolCallId}`;
}

export function toolProgressUpdateFromEvent(event: ToolProgressEvent): ToolProgressUpdate {
  return {
    threadId: event.threadId,
    turnId: event.turnId,
    toolCallId: event.toolCallId,
    seq: event.seq,
    ...(event.stream === "stdout" ? { stdout: event.chunk } : {}),
    ...(event.stream === "stderr" ? { stderr: event.chunk } : {}),
  };
}

export function mergeToolProgressBufferEvent(
  current: ToolProgressUpdate | undefined,
  event: ToolProgressEvent,
): ToolProgressUpdate {
  const next = toolProgressUpdateFromEvent(event);
  return {
    threadId: next.threadId,
    turnId: next.turnId,
    toolCallId: next.toolCallId,
    seq: next.seq,
    stdout: next.stdout !== undefined
      ? `${current?.stdout ?? ""}${next.stdout}`
      : current?.stdout,
    stderr: next.stderr !== undefined
      ? `${current?.stderr ?? ""}${next.stderr}`
      : current?.stderr,
  };
}

export function appendToolProgressToItems(
  items: Item[],
  progress: ToolProgressUpdate,
): Item[] {
  const index = items.findIndex(
    (item) =>
      item.kind === "tool" &&
      item.threadId === progress.threadId &&
      item.turnId === progress.turnId &&
      item.toolCallId === progress.toolCallId,
  );
  if (index < 0) return items;
  const item = items[index];
  if (item.kind !== "tool" || !acceptsLiveToolProgress(item)) return items;
  const current = item.status === "running"
    ? readToolProgressDisplayResult(item.result)
    : readToolProgressDisplayResult(readLiveProgressDisplayResult(item.result));
  const nextResult: ToolProgressDisplayResult = {
    kind: "tool_progress",
    ...appendProgressStream(current, "stdout", progress.stdout),
    ...appendProgressStream(current, "stderr", progress.stderr),
  };
  const next = [...items];
  next[index] = {
    ...item,
    result: item.status === "running"
      ? nextResult
      : mergeLiveProgressDisplayResult(item.result, nextResult),
  };
  return next;
}

function acceptsLiveToolProgress(item: Extract<Item, { kind: "tool" }>): boolean {
  return item.status === "running" ||
    (item.status === "completed" && item.name === "start_command_session");
}

function readToolProgressDisplayResult(result: unknown): ToolProgressDisplayResult {
  if (!result || typeof result !== "object") {
    return { kind: "tool_progress" };
  }
  const record = result as Record<string, unknown>;
  if (record.kind !== "tool_progress") {
    return { kind: "tool_progress" };
  }
  return {
    kind: "tool_progress",
    ...(typeof record.stdout === "string" ? { stdout: record.stdout } : {}),
    ...(typeof record.stderr === "string" ? { stderr: record.stderr } : {}),
    ...(record.stdoutTruncated === true ? { stdoutTruncated: true } : {}),
    ...(record.stderrTruncated === true ? { stderrTruncated: true } : {}),
  };
}

function readLiveProgressDisplayResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  return (result as Record<string, unknown>).liveProgress;
}

function mergeLiveProgressDisplayResult(
  result: unknown,
  liveProgress: ToolProgressDisplayResult,
): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { liveProgress };
  }
  return {
    ...result,
    liveProgress,
  };
}

function appendProgressStream(
  current: ToolProgressDisplayResult,
  stream: "stdout" | "stderr",
  chunk: string | undefined,
): Partial<ToolProgressDisplayResult> {
  const previous = current[stream] ?? "";
  const wasTruncated = stream === "stdout"
    ? current.stdoutTruncated === true
    : current.stderrTruncated === true;
  if (!chunk) {
    return stream === "stdout"
      ? { stdout: previous, stdoutTruncated: wasTruncated }
      : { stderr: previous, stderrTruncated: wasTruncated };
  }
  const combined = previous + chunk;
  const truncated = wasTruncated || combined.length > TOOL_PROGRESS_DISPLAY_MAX_CHARS;
  const text = truncated
    ? combined.slice(-TOOL_PROGRESS_DISPLAY_MAX_CHARS)
    : combined;
  return stream === "stdout"
    ? { stdout: text, stdoutTruncated: truncated }
    : { stderr: text, stderrTruncated: truncated };
}

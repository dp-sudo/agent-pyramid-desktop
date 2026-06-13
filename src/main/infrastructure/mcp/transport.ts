import type { JsonRpcNotification } from "./protocol.js";

export interface McpTransport {
  call(method: string, params: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
  onNotification(listener: (notification: JsonRpcNotification) => void): () => void;
  stderrTail(): string;
}

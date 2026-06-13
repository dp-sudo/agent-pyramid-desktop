import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { McpServerConfig } from "../../../shared/agent-contracts.js";
import {
  MCP_MAX_MESSAGE_BYTES,
  MCP_STDERR_BUFFER_BYTES,
} from "../../application/constants.js";
import {
  isJsonRpcNotification,
  isJsonRpcResponse,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./protocol.js";

export interface McpTransport {
  call(method: string, params: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
  onNotification(listener: (notification: JsonRpcNotification) => void): () => void;
  stderrTail(): string;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

/**
 * MCP stdio transport owns the subprocess boundary. Messages are newline
 * delimited JSON-RPC; malformed output, process exit, and cancellation reject
 * pending calls with concrete errors so plugin failures cannot hang runtime
 * turns or block unrelated MCP servers.
 */
export class StdioMcpTransport implements McpTransport {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly notifications = new Set<(notification: JsonRpcNotification) => void>();
  private stderr = "";
  private closed = false;
  private closePromise: Promise<void> | null = null;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    const reader = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    reader.on("line", (line) => this.handleLine(line));
    reader.on("close", () => this.failPending(new Error("MCP stdio stdout closed.")));
    this.child.stderr.on("data", (chunk: string | Buffer) => {
      this.appendStderr(String(chunk));
    });
    this.child.on("error", (error) => {
      this.closed = true;
      this.failPending(error);
    });
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      this.failPending(new Error(`MCP stdio process exited with code ${code ?? "null"} and signal ${signal ?? "null"}.`));
    });
  }

  static start(config: McpServerConfig): StdioMcpTransport {
    const child = spawn(config.command, config.args, {
      cwd: config.cwd,
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    return new StdioMcpTransport(child);
  }

  async call(
    method: string,
    params: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<unknown> {
    if (this.closed) {
      throw new Error("MCP stdio transport is closed.");
    }
    const id = this.nextId;
    this.nextId += 1;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    return new Promise<unknown>((resolve, reject) => {
      const abort = (): void => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} was aborted.`));
      };
      const cleanup = (): void => {
        options.signal?.removeEventListener("abort", abort);
      };
      if (options.signal?.aborted) {
        reject(new Error(`MCP request ${method} was aborted.`));
        return;
      }
      this.pending.set(id, { resolve, reject, cleanup });
      options.signal?.addEventListener("abort", abort, { once: true });
      this.writeMessage(request).catch((error) => {
        this.pending.delete(id);
        cleanup();
        reject(error);
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.writeMessage({
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.failPending(new Error("MCP stdio transport closed."));
    this.closePromise = new Promise((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) {
          this.child.kill("SIGKILL");
        }
      }, 500);
      this.child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.kill();
    });
    return this.closePromise;
  }

  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.notifications.add(listener);
    return () => {
      this.notifications.delete(listener);
    };
  }

  stderrTail(): string {
    return this.stderr;
  }

  private async writeMessage(message: JsonRpcRequest | Omit<JsonRpcRequest, "id">): Promise<void> {
    if (this.closed) {
      throw new Error("MCP stdio transport is closed.");
    }
    const payload = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(payload, "utf8") > MCP_MAX_MESSAGE_BYTES) {
      throw new Error("MCP stdio message exceeds the maximum size.");
    }
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(payload, "utf8", (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    if (Buffer.byteLength(line, "utf8") > MCP_MAX_MESSAGE_BYTES) {
      this.failPending(new Error("MCP stdio message exceeds the maximum size."));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.failPending(new Error(`MCP stdio emitted invalid JSON: ${messageOf(error)}`));
      return;
    }
    if (isJsonRpcResponse(parsed)) {
      this.handleResponse(parsed);
      return;
    }
    if (isJsonRpcNotification(parsed)) {
      for (const listener of this.notifications) {
        listener(parsed);
      }
      return;
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    pending.cleanup();
    if ("error" in response) {
      pending.reject(new Error(`MCP JSON-RPC error ${response.error.code}: ${response.error.message}`));
      return;
    }
    pending.resolve(response.result);
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.cleanup();
      pending.reject(error);
    }
  }

  private appendStderr(chunk: string): void {
    this.stderr += chunk;
    const bytes = Buffer.byteLength(this.stderr, "utf8");
    if (bytes <= MCP_STDERR_BUFFER_BYTES) return;
    let next = this.stderr;
    while (Buffer.byteLength(next, "utf8") > MCP_STDERR_BUFFER_BYTES) {
      next = next.slice(Math.max(1, Math.floor(next.length / 8)));
    }
    this.stderr = next;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

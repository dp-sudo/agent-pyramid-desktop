import type { McpServerConfig } from "../../../shared/agent-contracts.js";
import { MCP_MAX_MESSAGE_BYTES } from "../../application/constants.js";
import { diagnoseMcpHttpAuthFailure } from "./auth-diagnostics.js";
import {
  isJsonRpcNotification,
  isJsonRpcResponse,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./protocol.js";
import type { McpTransport } from "./transport.js";

/**
 * Streamable HTTP transport keeps the MCP session id returned by the server
 * and accepts either JSON or SSE responses. It does not expose credentials or
 * response bodies in errors, so configured authorization headers stay inside
 * the main-process network boundary.
 */
export class HttpMcpTransport implements McpTransport {
  private nextId = 1;
  private sessionId: string | null = null;
  private closed = false;
  private readonly notifications = new Set<(notification: JsonRpcNotification) => void>();

  private constructor(
    private readonly config: McpServerConfig,
    private readonly url: string,
    private readonly headers: Readonly<Record<string, string>>,
  ) {}

  static start(config: McpServerConfig): HttpMcpTransport {
    if (!config.url) {
      throw new Error(`MCP server ${config.name} requires a Streamable HTTP URL.`);
    }
    return new HttpMcpTransport(config, config.url, config.headers);
  }

  async call(
    method: string,
    params: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.nextId,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.nextId += 1;
    const response = await this.send(request, options.signal);
    if (!response) {
      throw new Error(`MCP HTTP request ${method} returned no JSON-RPC response.`);
    }
    if ("error" in response) {
      throw new Error(`MCP JSON-RPC error ${response.error.code}: ${response.error.message}`);
    }
    return response.result;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.send({
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.sessionId) return;
    const response = await fetch(this.url, {
      method: "DELETE",
      headers: this.requestHeaders(),
    });
    if (!response.ok && response.status !== 404 && response.status !== 405) {
      throw new Error(`MCP HTTP session close failed with status ${response.status}.`);
    }
  }

  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.notifications.add(listener);
    return () => {
      this.notifications.delete(listener);
    };
  }

  stderrTail(): string {
    return "";
  }

  private async send(
    message: JsonRpcRequest | Omit<JsonRpcRequest, "id">,
    signal?: AbortSignal,
  ): Promise<JsonRpcResponse | null> {
    if (this.closed) {
      throw new Error("MCP HTTP transport is closed.");
    }
    const payload = JSON.stringify(message);
    if (Buffer.byteLength(payload, "utf8") > MCP_MAX_MESSAGE_BYTES) {
      throw new Error("MCP HTTP message exceeds the maximum size.");
    }
    const response = await fetch(this.url, {
      method: "POST",
      headers: this.requestHeaders(),
      body: payload,
      ...(signal ? { signal } : {}),
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) {
      this.sessionId = sessionId;
    }
    if (!response.ok) {
      throw new Error(diagnoseMcpHttpAuthFailure(this.config, response.status).message);
    }
    if (response.status === 202 || response.status === 204) {
      return null;
    }
    const body = await readBoundedResponseBody(response);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const messages = contentType.includes("text/event-stream")
      ? parseSseMessages(body)
      : [parseJsonMessage(body)];
    let matched: JsonRpcResponse | null = null;
    for (const candidate of messages) {
      if (isJsonRpcNotification(candidate)) {
        for (const listener of this.notifications) {
          listener(candidate);
        }
      } else if (isJsonRpcResponse(candidate) && "id" in message && candidate.id === message.id) {
        matched = candidate;
      }
    }
    return matched;
  }

  private requestHeaders(): Record<string, string> {
    return {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...this.headers,
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
    };
  }
}

async function readBoundedResponseBody(response: Response): Promise<string> {
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MCP_MAX_MESSAGE_BYTES) {
    throw new Error("MCP HTTP response exceeds the maximum size.");
  }
  return body;
}

function parseJsonMessage(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`MCP HTTP emitted invalid JSON: ${messageOf(error)}`);
  }
}

function parseSseMessages(body: string): unknown[] {
  const messages: unknown[] = [];
  for (const event of body.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    messages.push(parseJsonMessage(data));
  }
  return messages;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

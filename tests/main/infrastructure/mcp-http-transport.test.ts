import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { HttpMcpTransport } from "../../../src/main/infrastructure/mcp/http-transport";
import type { McpServerConfig } from "../../../src/shared/agent-contracts";

describe("HttpMcpTransport", () => {
  const servers: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  it("posts JSON-RPC requests, preserves session id, and parses SSE responses", async () => {
    const seenSessionHeaders: Array<string | undefined> = [];
    const server = await listen(async (request, response) => {
      if (request.method === "DELETE") {
        response.statusCode = 204;
        response.end();
        return;
      }
      const body = await readBody(request);
      const payload = JSON.parse(body) as { id?: number; method: string };
      seenSessionHeaders.push(request.headers["mcp-session-id"] as string | undefined);
      if (payload.method === "initialize") {
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Mcp-Session-Id", "session-1");
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: { capabilities: { tools: {} } },
        }));
        return;
      }
      response.setHeader("Content-Type", "text/event-stream");
      response.end([
        "event: message",
        `data: ${JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: { tools: [] },
        })}`,
        "",
        "",
      ].join("\n"));
    });
    servers.push(server);
    const transport = HttpMcpTransport.start(config(server.url));

    await expect(transport.call("initialize", {})).resolves.toEqual({
      capabilities: { tools: {} },
    });
    await expect(transport.call("tools/list", {})).resolves.toEqual({ tools: [] });
    await transport.close();

    expect(seenSessionHeaders).toEqual([undefined, "session-1"]);
  });

  it("diagnoses HTTP auth failures without exposing configured secrets", async () => {
    const server = await listen((_request, response) => {
      response.statusCode = 401;
      response.end("token was wrong");
    });
    servers.push(server);
    const transport = HttpMcpTransport.start(config(server.url));

    await expect(transport.call("initialize", {})).rejects.toThrow(
      "authentication failed even though auth material is configured in headers",
    );
    await expect(transport.call("initialize", {})).rejects.not.toThrow("Bearer test");
  });

  it("reports missing HTTP auth material when a server requires it", async () => {
    const server = await listen((_request, response) => {
      response.statusCode = 403;
      response.end();
    });
    servers.push(server);
    const transport = HttpMcpTransport.start({
      ...config(server.url),
      headers: {},
    });

    await expect(transport.call("initialize", {})).rejects.toThrow(
      "authentication appears required and no auth material is configured",
    );
  });
});

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected test server address.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function config(url: string): McpServerConfig {
  return {
    id: "server-1",
    name: "remote-mcp",
    transport: "streamable-http",
    args: [],
    env: {},
    url,
    headers: { Authorization: "Bearer test" },
    enabled: true,
    readOnlyTools: [],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  };
}

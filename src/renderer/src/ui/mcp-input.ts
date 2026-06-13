import type {
  IpcResult,
  McpPromptGetRequest,
  McpPromptResult,
  McpResourceReadRequest,
  McpResourceReadResult,
  McpServerPromptsRequest,
  McpServerPromptsResponse,
  McpServerResourcesRequest,
  McpServerResourcesResponse,
} from "../../../shared/agent-contracts";

const MCP_PROMPT_COMMAND_PATTERN = /^\/mcp__([A-Za-z0-9_-]+)__([A-Za-z0-9_-]+)(?:\s+(.*))?$/s;
const MCP_RESOURCE_REFERENCE_PATTERN = /(^|[\s([{])@([A-Za-z0-9_-]+):([^\s)\]},;]+)/g;
const MAX_MCP_RESOURCE_TEXT_CHARS = 24_000;

export interface McpInputApi {
  listPrompts(request?: McpServerPromptsRequest): Promise<IpcResult<McpServerPromptsResponse>>;
  getPrompt(request: McpPromptGetRequest): Promise<IpcResult<McpPromptResult>>;
  listResources(
    request?: McpServerResourcesRequest,
  ): Promise<IpcResult<McpServerResourcesResponse>>;
  readResource(request: McpResourceReadRequest): Promise<IpcResult<McpResourceReadResult>>;
}

export interface McpInputPayload {
  text: string;
  displayText?: string;
  threadTitle: string;
}

export type McpInputResolution =
  | { ok: true; value: McpInputPayload }
  | { ok: false; message: string };

export type McpInputTranslator = (key: string, options?: Record<string, unknown>) => string;

interface McpPromptCommand {
  serverSegment: string;
  promptSegment: string;
  args: string[];
}

interface McpResourceReference {
  token: string;
  serverSegment: string;
  uri: string;
}

interface ResolvedMcpResource {
  reference: McpResourceReference;
  serverName: string;
  result: McpResourceReadResult;
}

/**
 * MCP slash prompts and resource refs are resolved before a turn starts so the
 * persisted user item can keep the visible command while the model receives the
 * concrete prompt/resource text through the existing TurnStartRequest contract.
 */
export async function resolveMcpInputReferences(
  payload: McpInputPayload,
  api: McpInputApi,
  t: McpInputTranslator = defaultMcpInputTranslator,
): Promise<McpInputResolution> {
  const visibleText = payload.displayText ?? payload.text;
  let text = payload.text;
  let displayText = payload.displayText;
  let threadTitle = payload.threadTitle;

  const promptCommand = parseMcpPromptCommand(text, t);
  if (!promptCommand.ok) {
    return { ok: false, message: promptCommand.message };
  }
  if (promptCommand.command) {
    const prompt = await resolveMcpPromptCommand(promptCommand.command, api, t);
    if (!prompt.ok) return prompt;
    text = prompt.value;
    displayText = visibleText;
    threadTitle = visibleText;
  }

  const resources = await resolveMcpResourceReferences(text, api, t);
  if (!resources.ok) return resources;
  if (resources.value.length > 0) {
    text = `${text}\n\n${serializeMcpResourceContext(resources.value)}`;
    displayText = displayText ?? visibleText;
  }

  return {
    ok: true,
    value: {
      text,
      ...(displayText !== undefined ? { displayText } : {}),
      threadTitle,
    },
  };
}

export function parseMcpPromptCommand(
  text: string,
  t: McpInputTranslator = defaultMcpInputTranslator,
): { ok: true; command: McpPromptCommand | null } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/mcp__")) {
    return { ok: true, command: null };
  }
  const match = MCP_PROMPT_COMMAND_PATTERN.exec(trimmed);
  if (!match) {
    return {
      ok: false,
      message: t("composer.mcpPromptCommandInvalid"),
    };
  }
  return {
    ok: true,
    command: {
      serverSegment: match[1],
      promptSegment: match[2],
      args: splitMcpPositionalArguments(match[3] ?? ""),
    },
  };
}

export function findMcpResourceReferences(text: string): McpResourceReference[] {
  const references: McpResourceReference[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MCP_RESOURCE_REFERENCE_PATTERN)) {
    const rawUri = trimTrailingResourcePunctuation(match[3]);
    if (!rawUri) continue;
    const reference: McpResourceReference = {
      token: `@${match[2]}:${rawUri}`,
      serverSegment: match[2],
      uri: rawUri,
    };
    const key = `${reference.serverSegment}\0${reference.uri}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push(reference);
  }
  return references;
}

async function resolveMcpPromptCommand(
  command: McpPromptCommand,
  api: McpInputApi,
  t: McpInputTranslator,
): Promise<{ ok: true; value: string } | { ok: false; message: string }> {
  const prompts = await api.listPrompts();
  if (!prompts.ok) {
    return { ok: false, message: prompts.message };
  }
  const server = prompts.value.servers.find(
    (candidate) => toMcpNameSegment(candidate.serverName) === command.serverSegment,
  );
  if (!server) {
    return {
      ok: false,
      message: t("composer.mcpPromptServerNotFound", { server: command.serverSegment }),
    };
  }
  const prompt = server.prompts.find(
    (candidate) => toMcpNameSegment(candidate.name) === command.promptSegment,
  );
  if (!prompt) {
    return {
      ok: false,
      message: t("composer.mcpPromptNotFound", {
        server: command.serverSegment,
        prompt: command.promptSegment,
      }),
    };
  }
  if (command.args.length > prompt.arguments.length) {
    return {
      ok: false,
      message: t("composer.mcpPromptTooManyArgs", {
        prompt: prompt.name,
        count: prompt.arguments.length,
      }),
    };
  }
  const missing = prompt.arguments
    .filter((argument, index) => argument.required && !command.args[index])
    .map((argument) => argument.name);
  if (missing.length > 0) {
    return {
      ok: false,
      message: t("composer.mcpPromptMissingArgs", {
        prompt: prompt.name,
        args: missing.join(", "),
      }),
    };
  }
  const args = Object.fromEntries(
    prompt.arguments
      .map((argument, index) => [argument.name, command.args[index]] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
  );
  const result = await api.getPrompt({
    serverId: server.serverId,
    name: prompt.name,
    arguments: args,
  });
  if (!result.ok) {
    return { ok: false, message: result.message };
  }
  const text = serializeMcpPromptResult(result.value);
  if (!text.trim()) {
    return { ok: false, message: t("composer.mcpPromptEmpty", { prompt: prompt.name }) };
  }
  return { ok: true, value: text };
}

async function resolveMcpResourceReferences(
  text: string,
  api: McpInputApi,
  t: McpInputTranslator,
): Promise<{ ok: true; value: ResolvedMcpResource[] } | { ok: false; message: string }> {
  const references = findMcpResourceReferences(text);
  if (references.length === 0) {
    return { ok: true, value: [] };
  }

  const resources = await api.listResources();
  if (!resources.ok) {
    return { ok: false, message: resources.message };
  }

  const resolved: ResolvedMcpResource[] = [];
  for (const reference of references) {
    const server = resources.value.servers.find(
      (candidate) => toMcpNameSegment(candidate.serverName) === reference.serverSegment,
    );
    if (!server) {
      return {
        ok: false,
        message: t("composer.mcpResourceServerNotFound", { server: reference.serverSegment }),
      };
    }
    const result = await api.readResource({
      serverId: server.serverId,
      uri: reference.uri,
    });
    if (!result.ok) {
      return { ok: false, message: result.message };
    }
    resolved.push({
      reference,
      serverName: server.serverName,
      result: result.value,
    });
  }
  return { ok: true, value: resolved };
}

function serializeMcpPromptResult(result: McpPromptResult): string {
  const messages = result.messages
    .map((message) => ({
      role: message.role,
      text: serializeMcpContent(message.content),
    }))
    .filter((message) => message.text.trim().length > 0);
  if (messages.length === 1) {
    return messages[0].text.trim();
  }
  return messages
    .map((message) => `${message.role}:\n${message.text.trim()}`)
    .join("\n\n");
}

function serializeMcpResourceContext(resources: readonly ResolvedMcpResource[]): string {
  const blocks = resources.map((resource) => {
    const contents = resource.result.contents.map(serializeMcpResourceContent).join("\n\n");
    return [
      `Reference: ${resource.reference.token}`,
      `Server: ${resource.serverName}`,
      `URI: ${resource.reference.uri}`,
      contents,
    ].join("\n");
  });
  return ["MCP resources:", ...blocks].join("\n\n");
}

function serializeMcpResourceContent(content: McpResourceReadResult["contents"][number]): string {
  if (typeof content.text === "string") {
    return truncateMcpResourceText(content.text);
  }
  if (typeof content.blob === "string") {
    return `[Binary MCP resource omitted${content.mimeType ? `: ${content.mimeType}` : ""}]`;
  }
  return "[Empty MCP resource content]";
}

function serializeMcpContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(serializeMcpContent).filter(Boolean).join("\n");
  }
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text;
    if (typeof value.type === "string" && typeof value.mimeType === "string") {
      return `[MCP ${value.type} content omitted: ${value.mimeType}]`;
    }
    return JSON.stringify(value);
  }
  return value === undefined ? "" : JSON.stringify(value);
}

function truncateMcpResourceText(text: string): string {
  if (text.length <= MAX_MCP_RESOURCE_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_MCP_RESOURCE_TEXT_CHARS)}\n[Truncated MCP resource text]`;
}

function splitMcpPositionalArguments(text: string): string[] {
  return text.trim() ? text.trim().split(/\s+/) : [];
}

function trimTrailingResourcePunctuation(value: string): string {
  return value.replace(/[.,:!?]+$/g, "");
}

function toMcpNameSegment(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "tool";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultMcpInputTranslator(key: string, options?: Record<string, unknown>): string {
  const templates: Record<string, string> = {
    "composer.mcpPromptCommandInvalid":
      "MCP prompt commands must use /mcp__server__prompt followed by positional arguments.",
    "composer.mcpPromptServerNotFound": "MCP prompt server was not found: {{server}}",
    "composer.mcpPromptNotFound": "MCP prompt was not found: {{server}}/{{prompt}}",
    "composer.mcpPromptTooManyArgs":
      "MCP prompt {{prompt}} accepts {{count}} positional arguments.",
    "composer.mcpPromptMissingArgs": "MCP prompt {{prompt}} requires arguments: {{args}}",
    "composer.mcpPromptEmpty": "MCP prompt {{prompt}} returned no text content.",
    "composer.mcpResourceServerNotFound": "MCP resource server was not found: {{server}}",
  };
  const template = templates[key] ?? key;
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
    String(options?.[name] ?? ""));
}

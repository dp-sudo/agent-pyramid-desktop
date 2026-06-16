import type { LlmRequest } from "../../domain/agent/types";

export const OPENAI_CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
export const ANTHROPIC_MESSAGES_PATH = "/anthropic/v1/messages";
export const DEEPSEEK_CHAT_COMPLETIONS_PATH = "/chat/completions";

export type ProviderDialect = "minimax" | "deepseek" | "custom";

// Provider error bodies flow into thrown Error messages, which are surfaced to
// the renderer (runtime_error) and persisted to events.jsonl. A compromised or
// misbehaving provider could echo the request's Authorization header or a key
// in its response body, widening the API key's exposure surface. Strip common
// credential patterns (auth headers, sk-/key- tokens, JWTs) before embedding a
// body slice in an error (H-3). Status + redacted reason stays for debugging.
const SECRET_REDACTION_PATTERNS: readonly RegExp[] = [
  // Header echoes: Authorization: Bearer xxx, x-api-key: xxx, api-key: xxx
  /(?:authorization|x-api-key|api-key|proxy-authorization)\s*[:=]\s*"?[^\s",}]+/gi,
  // Inline bearer tokens.
  /\bBearer\s+[A-Za-z0-9._\-]+/g,
  // Provider key prefixes: sk-..., key-..., cr_..., plus generic JWT (eyJ...).
  /\bsk-[A-Za-z0-9_\-]{6,}/g,
  /\bkey-[A-Za-z0-9_\-]{6,}/g,
  /\bcr_[A-Za-z0-9_\-]{6,}/g,
  /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]*\.?[A-Za-z0-9_\-]*/g,
];

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_REDACTION_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

export function resolveEndpoint(baseUrl: string, path: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("base_url is required.");
  }

  if (path === OPENAI_CHAT_COMPLETIONS_PATH && trimmed.endsWith("/v1")) {
    return `${trimmed}/chat/completions`;
  }

  if (path === OPENAI_CHAT_COMPLETIONS_PATH && trimmed.endsWith("/anthropic")) {
    return `${trimmed.slice(0, -"/anthropic".length)}${OPENAI_CHAT_COMPLETIONS_PATH}`;
  }

  if (path === ANTHROPIC_MESSAGES_PATH && trimmed.endsWith("/v1")) {
    return `${trimmed.slice(0, -3)}${ANTHROPIC_MESSAGES_PATH}`;
  }

  if (
    path === ANTHROPIC_MESSAGES_PATH &&
    trimmed.endsWith("/anthropic")
  ) {
    return `${trimmed}/v1/messages`;
  }

  return `${trimmed}${path}`;
}

export function resolveOpenAiEndpoint(baseUrl: string, dialect: ProviderDialect): string {
  return dialect === "deepseek"
    ? resolveEndpoint(baseUrl, DEEPSEEK_CHAT_COMPLETIONS_PATH)
    : resolveEndpoint(baseUrl, OPENAI_CHAT_COMPLETIONS_PATH);
}

export function resolveProviderDialect(provider: string): ProviderDialect {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "minimax") return "minimax";
  if (normalized === "deepseek") return "deepseek";
  return "custom";
}

// The gateway owns provider environment fallback so AgentRuntime can pass the
// profile key without duplicating provider-name branches across runtime layers.
export function resolveRequestApiKey(request: LlmRequest): string {
  if (request.apiKey) return request.apiKey;
  const dialect = resolveProviderDialect(request.provider);
  if (dialect === "deepseek") {
    return process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || "";
  }
  if (dialect === "minimax") {
    return process.env.MINIMAX_API_KEY || process.env.OPENAI_API_KEY || "";
  }
  return process.env.OPENAI_API_KEY || "";
}

export async function postJson<T>(
  url: string,
  apiKey: string,
  body: unknown,
  protocol: LlmRequest["protocol"],
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `LLM ${protocol} request failed with HTTP ${response.status}: ${redactSecrets(responseText.slice(0, 800))}`,
    );
  }

  try {
    return JSON.parse(responseText) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`LLM ${protocol} response was not valid JSON: ${reason}`);
  }
}

export async function postStream(
  url: string,
  apiKey: string,
  body: unknown,
  protocol: LlmRequest["protocol"],
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(
      `LLM ${protocol} stream failed with HTTP ${response.status}: ${redactSecrets(responseText.slice(0, 800))}`,
    );
  }

  if (!response.body) {
    throw new Error(`LLM ${protocol} stream response had no body.`);
  }

  return response;
}

export function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

export function parseToolArguments(raw: string, toolName: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Tool arguments must be a JSON object.");
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse arguments for tool "${toolName}": ${reason}`);
  }
}

export function requiredStreamToolName(value: string | undefined, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is missing a tool name.`);
  }
  return value;
}

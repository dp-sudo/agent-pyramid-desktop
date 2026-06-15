import type { AgentMessage, AgentToolDefinition } from "../domain/agent/types.js";
import type { RuntimePreferences } from "../../shared/agent-contracts.js";
import {
  CONTEXT_BUDGET_SAFETY_RATIO,
  MAX_PROGRESSIVE_COMPACTION_PASSES,
  MIN_PROGRESSIVE_COMPACTION_BYTES,
  MIN_TEXT_COMPACTION_BYTES,
  TIGHT_ASSISTANT_MESSAGE_MAX_BYTES,
  TIGHT_SYSTEM_MESSAGE_MAX_BYTES,
  TIGHT_TOOL_ARGUMENT_ARRAY_MAX_ITEMS,
  TIGHT_TOOL_ARGUMENT_STRING_MAX_BYTES,
  TIGHT_TOOL_RESULT_MAX_BYTES,
  TIGHT_TOOL_RESULT_MAX_LINES,
  TIGHT_USER_MESSAGE_MAX_BYTES,
  TOKEN_ESTIMATE_BYTES_PER_TOKEN,
  TOOL_ARGUMENT_ARRAY_MAX_ITEMS,
  TOOL_ARGUMENT_STRING_MAX_BYTES,
  TOOL_RESULT_MAX_BYTES,
  TOOL_RESULT_MAX_LINES,
} from "./constants.js";

/**
 * Builds the model-request view of thread history without mutating persisted
 * items. Older dynamic history may be trimmed or compacted, but the latest user
 * segment remains present so tight budgets still produce a traceable request.
 */
export function prepareMessagesForRequest(
  messages: AgentMessage[],
  options: {
    systemPrompt: string;
    tools: AgentToolDefinition[];
    compactTokenLimit: number;
    contextWindow: number;
    maxTokens: number;
    compaction: RuntimePreferences["compaction"];
  },
): AgentMessage[] {
  const budget = resolveContextBudget(options);
  const repairedMessages = repairModelToolHistory(messages);
  if (!options.compaction.enabled) {
    return enforceHardContextLimit(repairedMessages, budget);
  }

  if (options.compaction.strategy === "recent-only") {
    return prepareRecentOnlyMessages(repairedMessages, budget);
  }

  if (options.compaction.strategy === "aggressive") {
    return prepareAggressiveMessages(repairedMessages, budget);
  }

  let prepared = applyRequestHistoryHygiene(
    repairedMessages,
    options.compaction.strategy === "preserve-tools"
      ? PRESERVE_TOOLS_REQUEST_HYGIENE_PROFILE
      : DEFAULT_REQUEST_HYGIENE_PROFILE,
  );
  if (isWithinRequestBudget(prepared, budget)) {
    return prepared;
  }

  prepared = trimOldestDynamicMessages(prepared, budget);
  if (isWithinRequestBudget(prepared, budget)) {
    return prepared;
  }

  prepared = applyRequestHistoryHygiene(prepared, TIGHT_REQUEST_HYGIENE_PROFILE);
  if (isWithinRequestBudget(prepared, budget)) {
    return prepared;
  }

  prepared = trimOldestDynamicMessages(prepared, budget);
  if (isWithinRequestBudget(prepared, budget)) {
    return prepared;
  }

  return compactMandatoryMessagesToFit(prepared, budget);
}

function prepareRecentOnlyMessages(
  messages: AgentMessage[],
  budget: ResolvedContextBudget,
): AgentMessage[] {
  if (isWithinRequestBudget(messages, budget)) {
    return messages;
  }

  let prepared = trimOldestDynamicMessages(messages, budget);
  if (isWithinRequestBudget(prepared, budget)) {
    return prepared;
  }

  prepared = applyRequestHistoryHygiene(prepared, TIGHT_REQUEST_HYGIENE_PROFILE);
  if (isWithinRequestBudget(prepared, budget)) {
    return prepared;
  }

  return compactMandatoryMessagesToFit(prepared, budget);
}

function prepareAggressiveMessages(
  messages: AgentMessage[],
  budget: ResolvedContextBudget,
): AgentMessage[] {
  let prepared = applyRequestHistoryHygiene(messages, TIGHT_REQUEST_HYGIENE_PROFILE);
  if (isWithinRequestBudget(prepared, budget)) {
    return prepared;
  }

  prepared = trimOldestDynamicMessages(prepared, budget);
  if (isWithinRequestBudget(prepared, budget)) {
    return prepared;
  }

  return compactMandatoryMessagesToFit(prepared, budget);
}

function enforceHardContextLimit(
  messages: AgentMessage[],
  budget: ResolvedContextBudget,
): AgentMessage[] {
  if (isWithinRequestBudget(messages, budget)) {
    return messages;
  }

  const trimmed = trimOldestDynamicMessages(messages, budget);
  if (isWithinRequestBudget(trimmed, budget)) {
    return trimmed;
  }

  return compactMandatoryMessagesToFit(trimmed, budget);
}

interface ContextBudgetOptions {
  systemPrompt: string;
  tools: AgentToolDefinition[];
  compactTokenLimit: number;
  contextWindow: number;
  maxTokens: number;
}

interface ResolvedContextBudget {
  systemPrompt: string;
  tools: AgentToolDefinition[];
  tokenLimit: number;
}

interface RequestHygieneProfile {
  toolResultMaxLines: number;
  toolResultMaxBytes: number;
  toolArgumentStringMaxBytes: number;
  toolArgumentArrayMaxItems: number;
}

const DEFAULT_REQUEST_HYGIENE_PROFILE: RequestHygieneProfile = {
  toolResultMaxLines: TOOL_RESULT_MAX_LINES,
  toolResultMaxBytes: TOOL_RESULT_MAX_BYTES,
  toolArgumentStringMaxBytes: TOOL_ARGUMENT_STRING_MAX_BYTES,
  toolArgumentArrayMaxItems: TOOL_ARGUMENT_ARRAY_MAX_ITEMS,
};

const TIGHT_REQUEST_HYGIENE_PROFILE: RequestHygieneProfile = {
  toolResultMaxLines: TIGHT_TOOL_RESULT_MAX_LINES,
  toolResultMaxBytes: TIGHT_TOOL_RESULT_MAX_BYTES,
  toolArgumentStringMaxBytes: TIGHT_TOOL_ARGUMENT_STRING_MAX_BYTES,
  toolArgumentArrayMaxItems: TIGHT_TOOL_ARGUMENT_ARRAY_MAX_ITEMS,
};

const PRESERVE_TOOLS_REQUEST_HYGIENE_PROFILE: RequestHygieneProfile = {
  toolResultMaxLines: TOOL_RESULT_MAX_LINES,
  toolResultMaxBytes: TOOL_RESULT_MAX_BYTES,
  toolArgumentStringMaxBytes: TIGHT_TOOL_ARGUMENT_STRING_MAX_BYTES,
  toolArgumentArrayMaxItems: TIGHT_TOOL_ARGUMENT_ARRAY_MAX_ITEMS,
};

function resolveContextBudget(options: ContextBudgetOptions): ResolvedContextBudget {
  const configuredLimit = Math.max(1, options.compactTokenLimit);
  const contextWindow = Math.max(1, options.contextWindow);
  const maxOutputTokens = Math.max(0, options.maxTokens);
  const availableInputTokens = Math.max(1, contextWindow - maxOutputTokens);
  return {
    systemPrompt: options.systemPrompt,
    tools: options.tools,
    tokenLimit: Math.max(
      1,
      Math.floor(Math.min(configuredLimit, availableInputTokens) * CONTEXT_BUDGET_SAFETY_RATIO),
    ),
  };
}

function isWithinRequestBudget(
  messages: AgentMessage[],
  budget: ResolvedContextBudget,
): boolean {
  return estimateRequestTokens(budget.systemPrompt, messages, budget.tools) <= budget.tokenLimit;
}

/**
 * Provider APIs reject orphan tool results and assistant tool calls that are not
 * followed by matching results. Repair only the request view so persisted JSONL
 * remains auditable while model-bound history stays protocol-valid.
 */
function repairModelToolHistory(messages: AgentMessage[]): AgentMessage[] {
  let changed = false;
  const repaired: AgentMessage[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "tool") {
      changed = true;
      continue;
    }

    if (message.role !== "assistant" || !message.toolCalls?.length) {
      repaired.push(message);
      continue;
    }

    const expectedToolCallIds = new Set(message.toolCalls.map((call) => call.id));
    const resultIds = new Set<string>();
    const toolResultById = new Map<string, AgentMessage>();
    let cursor = index + 1;
    while (cursor < messages.length) {
      const candidate = messages[cursor];
      if (candidate.role !== "tool") break;
      if (
        candidate.toolCallId &&
        expectedToolCallIds.has(candidate.toolCallId) &&
        !resultIds.has(candidate.toolCallId)
      ) {
        resultIds.add(candidate.toolCallId);
        toolResultById.set(candidate.toolCallId, candidate);
      } else {
        changed = true;
      }
      cursor += 1;
    }

    const toolCalls = message.toolCalls.filter((call) => resultIds.has(call.id));
    if (toolCalls.length > 0) {
      if (toolCalls.length !== message.toolCalls.length) {
        changed = true;
        repaired.push({ ...message, toolCalls });
      } else {
        repaired.push(message);
      }
      for (const call of toolCalls) {
        const result = toolResultById.get(call.id);
        if (result) repaired.push(result);
      }
    } else {
      changed = true;
      if (hasNonEmptyContent(message.content)) {
        const assistantMessage: AgentMessage = { ...message };
        delete assistantMessage.toolCalls;
        repaired.push(assistantMessage);
      }
    }
    index = cursor - 1;
  }

  return changed ? repaired : messages;
}

function hasNonEmptyContent(content: AgentMessage["content"]): boolean {
  if (typeof content === "string") {
    return content.trim().length > 0;
  }
  return content.some((block) =>
    block.type === "image" ||
    (block.type === "text" && block.text.trim().length > 0)
  );
}

function applyRequestHistoryHygiene(
  messages: AgentMessage[],
  profile: RequestHygieneProfile,
): AgentMessage[] {
  let changed = false;
  const completedToolCallIds = new Set(
    messages
      .filter((message) => message.role === "tool" && message.toolCallId)
      .map((message) => message.toolCallId as string),
  );
  const next = messages.map((message) => {
    if (message.role === "tool") {
      const content = compactToolResultContent(message.content, profile);
      if (content === message.content) return message;
      changed = true;
      return { ...message, content };
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      let toolCallsChanged = false;
      const toolCalls = message.toolCalls.map((call) => {
        if (!completedToolCallIds.has(call.id)) return call;
        const compactedArguments = compactToolArguments(call.arguments, profile);
        if (compactedArguments === call.arguments) return call;
        changed = true;
        toolCallsChanged = true;
        return { ...call, arguments: compactedArguments };
      });
      return toolCallsChanged ? { ...message, toolCalls } : message;
    }

    return message;
  });
  return changed ? next : messages;
}

function trimOldestDynamicMessages(
  messages: AgentMessage[],
  budget: ResolvedContextBudget,
): AgentMessage[] {
  const segments = segmentMessagesForTrimming(messages);
  const lastUserSegmentIndex = findLastSegmentIndex(
    segments,
    (segment) => segment.some((message) => message.role === "user"),
  );
  const mandatoryStartIndex =
    lastUserSegmentIndex >= 0 ? lastUserSegmentIndex : Math.max(0, segments.length - 1);
  const keep = flattenSegments(segments.slice(mandatoryStartIndex));

  for (let index = mandatoryStartIndex - 1; index >= 0; index -= 1) {
    const candidate = [...segments[index], ...keep];
    if (!isWithinRequestBudget(candidate, budget)) {
      break;
    }
    keep.unshift(...segments[index]);
  }
  return keep.length > 0 ? keep : messages.slice(-1);
}

function compactMandatoryMessagesToFit(
  messages: AgentMessage[],
  budget: ResolvedContextBudget,
): AgentMessage[] {
  let prepared = compactMessages(messages, DEFAULT_MANDATORY_COMPACTION_PROFILE);
  for (let pass = 0; pass < MAX_PROGRESSIVE_COMPACTION_PASSES; pass += 1) {
    if (isWithinRequestBudget(prepared, budget)) {
      return prepared;
    }
    prepared = compactMessages(prepared, createProgressiveCompactionProfile(pass));
  }
  return prepared;
}

interface MandatoryCompactionProfile extends RequestHygieneProfile {
  systemMessageMaxBytes: number;
  assistantMessageMaxBytes: number;
  userMessageMaxBytes: number;
}

const DEFAULT_MANDATORY_COMPACTION_PROFILE: MandatoryCompactionProfile = {
  ...TIGHT_REQUEST_HYGIENE_PROFILE,
  systemMessageMaxBytes: TIGHT_SYSTEM_MESSAGE_MAX_BYTES,
  assistantMessageMaxBytes: TIGHT_ASSISTANT_MESSAGE_MAX_BYTES,
  userMessageMaxBytes: TIGHT_USER_MESSAGE_MAX_BYTES,
};

function createProgressiveCompactionProfile(pass: number): MandatoryCompactionProfile {
  const divisor = 2 ** (pass + 1);
  return {
    toolResultMaxLines: Math.max(1, Math.floor(TIGHT_TOOL_RESULT_MAX_LINES / divisor)),
    toolResultMaxBytes: Math.max(
      MIN_PROGRESSIVE_COMPACTION_BYTES,
      Math.floor(TIGHT_TOOL_RESULT_MAX_BYTES / divisor),
    ),
    toolArgumentStringMaxBytes: Math.max(
      MIN_PROGRESSIVE_COMPACTION_BYTES,
      Math.floor(TIGHT_TOOL_ARGUMENT_STRING_MAX_BYTES / divisor),
    ),
    toolArgumentArrayMaxItems: Math.max(1, Math.floor(TIGHT_TOOL_ARGUMENT_ARRAY_MAX_ITEMS / divisor)),
    systemMessageMaxBytes: Math.max(
      MIN_PROGRESSIVE_COMPACTION_BYTES,
      Math.floor(TIGHT_SYSTEM_MESSAGE_MAX_BYTES / divisor),
    ),
    assistantMessageMaxBytes: Math.max(
      MIN_PROGRESSIVE_COMPACTION_BYTES,
      Math.floor(TIGHT_ASSISTANT_MESSAGE_MAX_BYTES / divisor),
    ),
    userMessageMaxBytes: Math.max(
      MIN_PROGRESSIVE_COMPACTION_BYTES,
      Math.floor(TIGHT_USER_MESSAGE_MAX_BYTES / divisor),
    ),
  };
}

function compactMessages(
  messages: AgentMessage[],
  profile: MandatoryCompactionProfile,
): AgentMessage[] {
  return messages.map((message) => {
    let nextMessage = message;
    if (message.role === "tool") {
      nextMessage = {
        ...message,
        content: compactContentToBytes(message.content, profile.toolResultMaxBytes),
      };
    } else {
      const maxBytes =
        message.role === "system"
          ? profile.systemMessageMaxBytes
          : message.role === "assistant"
            ? profile.assistantMessageMaxBytes
            : profile.userMessageMaxBytes;
      nextMessage = {
        ...message,
        content: compactContentToBytes(message.content, maxBytes),
      };
    }

    if (message.role !== "assistant" || !message.toolCalls?.length) {
      return nextMessage;
    }

    let toolCallsChanged = false;
    const toolCalls = message.toolCalls.map((call) => {
      const compactedArguments = compactToolArguments(call.arguments, profile);
      if (compactedArguments === call.arguments) return call;
      toolCallsChanged = true;
      return { ...call, arguments: compactedArguments };
    });
    return toolCallsChanged ? { ...nextMessage, toolCalls } : nextMessage;
  });
}

function compactContentToBytes(
  content: AgentMessage["content"],
  maxBytes: number,
): AgentMessage["content"] {
  if (typeof content === "string") {
    return compactTextToBytes(content, maxBytes);
  }

  let changed = false;
  const blocks = content.map((block) => {
    if (block.type === "text") {
      const text = compactTextToBytes(block.text, maxBytes);
      if (text !== block.text) changed = true;
      return { ...block, text };
    }
    changed = true;
    return {
      type: "text" as const,
      text: `[context budget: omitted ${block.mimeType} attachment from oversized request message]`,
    };
  });
  return changed ? blocks : content;
}

function compactTextToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  if (maxBytes < MIN_TEXT_COMPACTION_BYTES) {
    return "[context budget: omitted oversized text]";
  }
  const marker = "\n[context budget: omitted oversized text middle]\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const available = Math.max(0, maxBytes - markerBytes);
  const headBytes = Math.floor(available * 0.6);
  const tailBytes = available - headBytes;
  return `${sliceUtf8(text, headBytes)}${marker}${sliceUtf8FromEnd(text, tailBytes)}`;
}

function segmentMessagesForTrimming(messages: AgentMessage[]): AgentMessage[][] {
  const segments: AgentMessage[][] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "system") {
      const segment = [message];
      let cursor = index + 1;
      while (cursor < messages.length && messages[cursor].role === "system") {
        segment.push(messages[cursor]);
        cursor += 1;
      }
      if (cursor < messages.length && messages[cursor].role === "user") {
        segment.push(messages[cursor]);
        segments.push(segment);
        index = cursor;
        continue;
      }
      segments.push(segment);
      index = cursor - 1;
      continue;
    }

    if (message.role !== "assistant" || !message.toolCalls?.length) {
      segments.push([message]);
      continue;
    }

    const expectedToolCallIds = new Set(message.toolCalls.map((call) => call.id));
    const segment = [message];
    let cursor = index + 1;
    while (cursor < messages.length) {
      const candidate = messages[cursor];
      if (candidate.role !== "tool" || !candidate.toolCallId || !expectedToolCallIds.has(candidate.toolCallId)) {
        break;
      }
      segment.push(candidate);
      cursor += 1;
    }
    segments.push(segment);
    index = cursor - 1;
  }
  return segments;
}

function findLastSegmentIndex(
  segments: AgentMessage[][],
  predicate: (segment: AgentMessage[]) => boolean,
): number {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (predicate(segments[index])) return index;
  }
  return -1;
}

function flattenSegments(segments: AgentMessage[][]): AgentMessage[] {
  return segments.flatMap((segment) => segment);
}

function compactToolResultContent(
  content: AgentMessage["content"],
  profile: RequestHygieneProfile,
): AgentMessage["content"] {
  if (typeof content === "string") {
    return compactToolResultText(content, profile);
  }
  let changed = false;
  const blocks = content.map((block) => {
    if (block.type === "text") {
      const text = compactToolResultText(block.text, profile);
      if (text !== block.text) changed = true;
      return { ...block, text };
    }
    changed = true;
    return {
      type: "text" as const,
      text: `[context budget: omitted ${block.mimeType} attachment from historical tool result]`,
    };
  });
  return changed ? blocks : content;
}

function compactToolResultText(text: string, profile: RequestHygieneProfile): string {
  const originalBytes = Buffer.byteLength(text, "utf8");
  const lines = text.split("\n");
  if (originalBytes <= profile.toolResultMaxBytes && lines.length <= profile.toolResultMaxLines) {
    return text;
  }

  const headCount = Math.min(80, Math.max(1, Math.floor(profile.toolResultMaxLines * 0.25)));
  const tailCount = Math.min(120, Math.max(1, Math.floor(profile.toolResultMaxLines * 0.35)));
  const signalLines = lines
    .slice(headCount, Math.max(headCount, lines.length - tailCount))
    .filter((line) => /\b(error|failed?|fatal|exception|warning|denied|timeout|not found|invalid)\b/i.test(line))
    .slice(0, Math.max(0, profile.toolResultMaxLines - headCount - tailCount));
  const selected = [
    ...lines.slice(0, headCount),
    ...signalLines,
    ...lines.slice(Math.max(headCount, lines.length - tailCount)),
  ];
  const fitted = fitLinesToBytes(selected, profile.toolResultMaxBytes);
  const omittedLines = Math.max(0, lines.length - fitted.length);
  const marker = `[context budget: omitted ${omittedLines} historical tool result line(s); narrow the next read/search for details]`;
  return [...fitted, marker].join("\n");
}

function compactToolArguments(
  args: Record<string, unknown>,
  profile: RequestHygieneProfile,
): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const compacted = compactArgumentValue(key, value, profile);
    out[key] = compacted.value;
    changed ||= compacted.changed;
  }
  return changed ? out : args;
}

function compactArgumentValue(
  key: string,
  value: unknown,
  profile: RequestHygieneProfile,
): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    if (isBase64Like(key, value)) {
      return {
        value: `[context budget: omitted base64 argument, ${Buffer.byteLength(value, "utf8")} bytes]`,
        changed: true,
      };
    }
    if (Buffer.byteLength(value, "utf8") > profile.toolArgumentStringMaxBytes) {
      return {
        value: compactArgumentString(value, profile.toolArgumentStringMaxBytes),
        changed: true,
      };
    }
    return { value, changed: false };
  }

  if (Array.isArray(value)) {
    let changed = false;
    const selected =
      value.length > profile.toolArgumentArrayMaxItems
        ? [
            ...value.slice(0, Math.floor(profile.toolArgumentArrayMaxItems * 0.75)),
            { context_budget_omitted_items: value.length - profile.toolArgumentArrayMaxItems },
            ...value.slice(
              -(profile.toolArgumentArrayMaxItems - Math.floor(profile.toolArgumentArrayMaxItems * 0.75)),
            ),
          ]
        : value;
    changed ||= selected !== value;
    const compacted = selected.map((item) => {
      const child = compactArgumentValue(key, item, profile);
      changed ||= child.changed;
      return child.value;
    });
    return changed ? { value: compacted, changed: true } : { value, changed: false };
  }

  if (!value || typeof value !== "object") {
    return { value, changed: false };
  }

  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    const child = compactArgumentValue(childKey, childValue, profile);
    out[childKey] = child.value;
    changed ||= child.changed;
  }
  return changed ? { value: out, changed: true } : { value, changed: false };
}

function compactArgumentString(value: string, maxBytes: number): string {
  if (maxBytes < MIN_TEXT_COMPACTION_BYTES) {
    return `[context budget: omitted long argument, ${Buffer.byteLength(value, "utf8")} bytes]`;
  }
  const marker = "\n[context budget: omitted long argument tail]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const headBytes = Math.max(0, maxBytes - markerBytes);
  return `${sliceUtf8(value, headBytes)}${marker}`;
}

function fitLinesToBytes(lines: string[], maxBytes: number): string[] {
  const out: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const nextBytes = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + nextBytes > maxBytes) break;
    out.push(line);
    bytes += nextBytes;
  }
  return out;
}

function sliceUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let out = "";
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    out += char;
    bytes += charBytes;
  }
  return out;
}

function sliceUtf8FromEnd(value: string, maxBytes: number): string {
  let bytes = 0;
  let out = "";
  const chars = Array.from(value);
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index];
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    out = `${char}${out}`;
    bytes += charBytes;
  }
  return out;
}

function estimateRequestTokens(
  systemPrompt: string,
  messages: AgentMessage[],
  tools: AgentToolDefinition[],
): number {
  return estimateTokens(
    stableStringifyForBudget({
      systemPrompt,
      messages,
      tools,
    }),
  );
}

function estimateTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / TOKEN_ESTIMATE_BYTES_PER_TOKEN);
}

function stableStringifyForBudget(value: unknown): string {
  return JSON.stringify(canonicalizeJsonForBudget(value));
}

function canonicalizeJsonForBudget(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJsonForBudget);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalizeJsonForBudget((value as Record<string, unknown>)[key]);
  }
  return out;
}

function isBase64Like(key: string, value: string): boolean {
  return (
    /(?:^|_)(?:data_)?base64$/i.test(key) ||
    /^data:[^;,]+;base64,/i.test(value)
  );
}

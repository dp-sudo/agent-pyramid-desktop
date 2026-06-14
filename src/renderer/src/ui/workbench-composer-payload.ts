import type { FloatingComposerRequestPayload } from "./components/composer";
import type { WriteAssistantPromptPayload } from "./components/write/write-workspace-model";
import {
  resolveMcpInputReferences,
  type McpInputPayload,
  type McpInputResolution,
  type McpInputTranslator,
} from "./mcp-input";

const WORKBENCH_THREAD_TITLE_MAX_CHARS = 60;
const WORKBENCH_THREAD_TITLE_ELLIPSIS = "...";

export type WorkbenchComposerSendPayload = Pick<FloatingComposerRequestPayload, "text"> &
  Partial<Omit<FloatingComposerRequestPayload, "text">> &
  Partial<Pick<WriteAssistantPromptPayload, "displayText" | "threadTitle">>;

export function buildComposerSendPayload(
  draftText: string,
  attachmentCount: number,
  t: McpInputTranslator,
): McpInputPayload | null {
  const text = draftText.trim();
  if (text.length > 0) {
    return { text, threadTitle: text };
  }
  if (attachmentCount <= 0) return null;

  const attachmentOnlyText = t(
    attachmentCount === 1
      ? "composer.attachmentOnlyMessageSingle"
      : "composer.attachmentOnlyMessageMultiple",
  );
  return {
    text: attachmentOnlyText,
    displayText: attachmentOnlyText,
    threadTitle: attachmentOnlyText,
  };
}

export async function resolveCodeMcpInputReferences(
  payload: McpInputPayload,
  t: McpInputTranslator,
): Promise<McpInputResolution> {
  if (!window.agentApi?.mcp) {
    return { ok: true, value: payload };
  }
  if (!payload.text.includes("/mcp__") && !payload.text.includes("@")) {
    return { ok: true, value: payload };
  }
  return resolveMcpInputReferences(payload, window.agentApi.mcp, t);
}

export function normalizeWriteAssistantSendPayload(
  payload: WorkbenchComposerSendPayload,
): WriteAssistantPromptPayload | null {
  const text = payload.text.trim();
  const displayText = payload.displayText?.trim() ?? "";
  const threadTitle = payload.threadTitle?.trim() ?? "";
  if (!text || !displayText || !threadTitle) return null;
  return {
    text,
    displayText,
    threadTitle,
    attachmentIds: payload.attachmentIds ?? [],
    mode: payload.mode ?? "agent",
    goalMode: payload.goalMode ?? false,
  };
}

export function buildWorkbenchThreadTitle(threadTitle: string): string {
  if (threadTitle.length <= WORKBENCH_THREAD_TITLE_MAX_CHARS) return threadTitle;
  const prefixLength =
    WORKBENCH_THREAD_TITLE_MAX_CHARS - WORKBENCH_THREAD_TITLE_ELLIPSIS.length;
  return `${threadTitle.slice(0, prefixLength)}${WORKBENCH_THREAD_TITLE_ELLIPSIS}`;
}

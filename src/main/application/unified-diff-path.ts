import { decodeCStyleEscapedPath } from "./c-style-path.js";

/**
 * Unified diff file headers are the single authority for apply_patch targets
 * and permission-rule subjects. This parser accepts Git-style quoted paths and
 * tab-separated timestamps while rejecting invalid paths before they can become
 * scoped approval grants.
 */
export function parseUnifiedDiffFilePath(raw: string, invalidMessage: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(invalidMessage);
  }

  const token = trimmed.startsWith("\"")
    ? parseQuotedPathToken(trimmed, invalidMessage)
    : parsePlainPathToken(trimmed);
  if (token === "/dev/null") {
    return undefined;
  }

  const normalized = token.startsWith("a/") || token.startsWith("b/")
    ? token.slice(2)
    : token;
  if (!normalized || normalized.includes("\0")) {
    throw new Error(invalidMessage);
  }
  return normalized;
}

function parsePlainPathToken(value: string): string {
  const tabIndex = value.indexOf("\t");
  return tabIndex === -1 ? value : value.slice(0, tabIndex).trimEnd();
}

function parseQuotedPathToken(value: string, invalidMessage: string): string {
  const closedAt = findClosingQuote(value);
  const trailing = value.slice(closedAt + 1);
  if (closedAt === -1 || (trailing.trim() && !trailing.startsWith("\t"))) {
    throw new Error(invalidMessage);
  }
  return decodeCStyleEscapedPath(value.slice(1, closedAt), {
    danglingBackslash: "throw",
    invalidMessage,
  });
}

function findClosingQuote(value: string): number {
  let escaped = false;
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      return index;
    }
  }
  return -1;
}

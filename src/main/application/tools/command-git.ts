import { decodeCStyleEscapedPath } from "../c-style-path.js";

export interface GitStatusEntry {
  xy: string;
  path: string;
  originalPath?: string;
}

/**
 * Git short status uses shell-like C quoting for paths with whitespace,
 * quotes, non-ASCII bytes, or rename arrows. Decode those paths before the
 * runtime exposes structured entries that later tool calls may reuse.
 */
export function parseGitStatusLine(line: string): GitStatusEntry {
  const xy = line.slice(0, 2);
  const payload = line.slice(3);
  const renameSeparator = " -> ";
  const renameIndex = findGitRenameSeparator(payload, renameSeparator);
  if (renameIndex !== -1) {
    const originalPath = payload.slice(0, renameIndex);
    const nextPath = payload.slice(renameIndex + renameSeparator.length);
    return {
      xy,
      path: decodeGitStatusPath(nextPath),
      originalPath: decodeGitStatusPath(originalPath),
    };
  }
  return {
    xy,
    path: decodeGitStatusPath(payload),
  };
}

function findGitRenameSeparator(payload: string, separator: string): number {
  let inQuote = false;
  let escaped = false;
  for (let index = 0; index <= payload.length - separator.length; index += 1) {
    const char = payload[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inQuote && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && payload.startsWith(separator, index)) {
      return index;
    }
  }
  return -1;
}

function decodeGitStatusPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith("\"") || !trimmed.endsWith("\"")) {
    return trimmed;
  }
  return decodeCStyleEscapedPath(trimmed.slice(1, -1));
}

export function assertPlainGitPathspec(pathspec: string, toolName: string): void {
  if (pathspec.startsWith(":")) {
    throw new Error(`${toolName} pathspec must be a plain workspace-relative path, not Git pathspec magic: ${pathspec}`);
  }
  if (/[*?\[]/.test(pathspec)) {
    throw new Error(`${toolName} pathspec must be a plain workspace-relative path, not a glob: ${pathspec}`);
  }
}

export function gitPathspecArgs(pathspecs: string[]): string[] {
  return pathspecs.length > 0 ? ["--", ...pathspecs] : [];
}

export function optionalGitLogRef(value: unknown): string | undefined {
  const ref = optionalGitString(value);
  if (!ref) return undefined;
  if (Buffer.byteLength(ref, "utf8") > 256) {
    throw new Error("git_log ref must be 256 bytes or less.");
  }
  if (ref.includes("\0")) {
    throw new Error("git_log ref cannot contain NUL bytes.");
  }
  if (/[\x01-\x1f\x7f\s]/.test(ref)) {
    throw new Error("git_log ref cannot contain whitespace or control characters.");
  }
  if (ref.startsWith("-")) {
    throw new Error(`git_log ref must be a revision, not a Git option: ${ref}`);
  }
  if (ref.startsWith(":")) {
    throw new Error(`git_log ref must be a revision, not Git pathspec magic: ${ref}`);
  }
  return ref;
}

function optionalGitString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error("optional string value must be a string.");
  }
  return value.trim() || undefined;
}

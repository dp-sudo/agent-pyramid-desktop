export interface GitStatusEntry {
  xy: string;
  path: string;
  originalPath?: string;
}

export function parseGitStatusLine(line: string): GitStatusEntry {
  const xy = line.slice(0, 2);
  const payload = line.slice(3);
  const renameSeparator = " -> ";
  if (payload.includes(renameSeparator)) {
    const [originalPath = "", nextPath = ""] = payload.split(renameSeparator);
    return {
      xy,
      path: nextPath,
      originalPath,
    };
  }
  return {
    xy,
    path: payload,
  };
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

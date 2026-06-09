import * as path from "node:path";

/**
 * Main-process path comparisons must follow the host OS semantics. Windows is
 * case-insensitive for normal project paths, so path.relative() is used instead
 * of raw string prefix checks at filesystem security boundaries.
 */
export function isSamePath(left: string, right: string): boolean {
  return platformPath().relative(left, right) === "";
}

export function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const pathApi = platformPath();
  const relative = pathApi.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !pathApi.isAbsolute(relative));
}

export function toPortableRelativePath(root: string, fullPath: string): string {
  const pathApi = platformPath();
  return pathApi.relative(root, fullPath).split(pathApi.sep).join("/");
}

function platformPath(): typeof path.posix {
  return process.platform === "win32" ? path.win32 : path.posix;
}

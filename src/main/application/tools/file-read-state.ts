import * as path from "node:path";

export interface FileReadState {
  path: string;
  content: string;
  mtimeMs: number;
  size: number;
  sha256: string;
  fullSha256?: string;
  truncated: boolean;
  offsetBytes?: number;
  bytesRead?: number;
}

const DEFAULT_MAX_ENTRIES = 100;

export class FileReadStateStore {
  private readonly entries = new Map<string, FileReadState>();

  constructor(private readonly maxEntries = DEFAULT_MAX_ENTRIES) {}

  get(filePath: string): FileReadState | undefined {
    return this.entries.get(normalizeKey(filePath));
  }

  set(filePath: string, state: Omit<FileReadState, "path">): void {
    const key = normalizeKey(filePath);
    this.entries.delete(key);
    this.entries.set(key, {
      ...state,
      path: key,
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") return;
      this.entries.delete(oldest);
    }
  }

  delete(filePath: string): void {
    this.entries.delete(normalizeKey(filePath));
  }

  clear(): void {
    this.entries.clear();
  }
}

function normalizeKey(filePath: string): string {
  return path.normalize(path.resolve(filePath));
}

import { randomUUID } from "node:crypto";
import * as path from "node:path";

type FileHistoryOperation = "create" | "update" | "delete" | "rollback";

export interface FileHistoryEntry {
  id: string;
  threadId: string;
  turnId: string;
  toolName: string;
  workspace: string;
  filePath: string;
  relativePath: string;
  operation: FileHistoryOperation;
  beforeContent: string | null;
  afterContent: string | null;
  beforeSha256: string | null;
  afterSha256: string | null;
  createdAt: string;
}

export interface FileHistoryInput {
  threadId: string;
  turnId: string;
  toolName: string;
  workspace: string;
  filePath: string;
  relativePath: string;
  operation: FileHistoryOperation;
  beforeContent: string | null;
  afterContent: string | null;
  beforeSha256: string | null;
  afterSha256: string | null;
}

const DEFAULT_MAX_ENTRIES_PER_FILE = 20;
const DEFAULT_MAX_TOTAL_ENTRIES = 500;

export class FileHistoryStore {
  private readonly entriesByFile = new Map<string, FileHistoryEntry[]>();

  constructor(
    private readonly maxEntriesPerFile = DEFAULT_MAX_ENTRIES_PER_FILE,
    private readonly maxTotalEntries = DEFAULT_MAX_TOTAL_ENTRIES,
  ) {}

  push(entry: FileHistoryInput): FileHistoryEntry {
    const key = normalizeKey(entry.filePath);
    const next: FileHistoryEntry = {
      ...entry,
      filePath: key,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const entries = this.entriesByFile.get(key) ?? [];
    entries.push(next);
    while (entries.length > this.maxEntriesPerFile) {
      entries.shift();
    }
    this.entriesByFile.set(key, entries);
    this.trimTotalEntries();
    return next;
  }

  latest(filePath: string): FileHistoryEntry | undefined {
    const entries = this.entriesByFile.get(normalizeKey(filePath));
    return entries?.at(-1);
  }

  clear(): void {
    this.entriesByFile.clear();
  }

  private trimTotalEntries(): void {
    while (this.totalEntries() > this.maxTotalEntries) {
      let oldestKey: string | undefined;
      let oldestCreatedAt: string | undefined;
      for (const [key, entries] of this.entriesByFile) {
        const first = entries[0];
        if (!first) continue;
        if (oldestCreatedAt === undefined || first.createdAt < oldestCreatedAt) {
          oldestCreatedAt = first.createdAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) return;
      const entries = this.entriesByFile.get(oldestKey);
      entries?.shift();
      if (!entries || entries.length === 0) {
        this.entriesByFile.delete(oldestKey);
      }
    }
  }

  private totalEntries(): number {
    let total = 0;
    for (const entries of this.entriesByFile.values()) {
      total += entries.length;
    }
    return total;
  }
}

function normalizeKey(filePath: string): string {
  return path.normalize(path.resolve(filePath));
}

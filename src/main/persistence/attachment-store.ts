import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type {
  AttachmentCreateRequest,
  AttachmentRecord,
} from "../../shared/agent-contracts.js";
import {
  MAX_ATTACHMENT_BYTES,
  isAttachmentRecord,
  isUuidString,
  normalizeSupportedAttachmentMimeType,
} from "../../shared/agent-contracts.js";

const ATTACHMENTS_DIRNAME = "attachments";
const INDEX_FILENAME = "index.json";
const TMP_SUFFIX = ".tmp";
export interface AttachmentContent extends AttachmentRecord {
  dataBase64: string;
}

export class AttachmentStore {
  private readonly attachmentsDir: string;
  private readonly indexPath: string;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(userDataDir: string) {
    this.attachmentsDir = path.join(userDataDir, ATTACHMENTS_DIRNAME);
    this.indexPath = path.join(this.attachmentsDir, INDEX_FILENAME);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await fs.mkdir(this.attachmentsDir, { recursive: true });
        if (!existsSync(this.indexPath)) {
          await this.atomicWriteJson([] as AttachmentRecord[]);
        }
        this.initialized = true;
      })();
    }
    try {
      await this.initPromise;
    } finally {
      if (!this.initialized) {
        this.initPromise = null;
      }
    }
  }

  async create(request: AttachmentCreateRequest): Promise<AttachmentRecord> {
    await this.init();
    const name = assertSafeName(request.name);
    const mimeType = assertImageMimeType(request.mimeType);
    const data = decodeBase64(request.dataBase64);
    if (data.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error("Attachment exceeds the 12MB size limit.");
    }

    const now = new Date().toISOString();
    const record: AttachmentRecord = {
      id: randomUUID(),
      name,
      mimeType,
      size: data.byteLength,
      createdAt: now,
    };
    return this.serialized(async () => {
      const filePath = this.attachmentPath(record.id);
      await fs.writeFile(filePath, data);
      try {
        const all = await this.readIndex();
        await this.atomicWriteJson([...all, record]);
      } catch (error) {
        await fs.rm(filePath, { force: true });
        throw error;
      }
      return record;
    });
  }

  async get(id: string): Promise<AttachmentContent | null> {
    await this.init();
    assertSafeId(id, "Attachment id");
    const record = (await this.list()).find((item) => item.id === id);
    if (!record) return null;
    try {
      const data = await fs.readFile(this.attachmentPath(id));
      return {
        ...record,
        dataBase64: data.toString("base64"),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    await this.init();
    assertSafeId(id, "Attachment id");
    await this.serialized(async () => {
      const all = await this.readIndex();
      const next = all.filter((item) => item.id !== id);
      if (next.length === all.length) {
        throw new Error(`Attachment ${id} not found.`);
      }
      await this.atomicWriteJson(next);
      await fs.rm(this.attachmentPath(id), { force: true });
    });
  }

  async list(): Promise<AttachmentRecord[]> {
    await this.init();
    return this.readIndex();
  }

  private async readIndex(): Promise<AttachmentRecord[]> {
    const raw = await fs.readFile(this.indexPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAttachmentRecord);
  }

  private attachmentPath(id: string): string {
    return path.join(this.attachmentsDir, `${assertSafeId(id, "Attachment id")}.bin`);
  }

  private async atomicWriteJson(value: AttachmentRecord[]): Promise<void> {
    const tmp = this.indexPath + TMP_SUFFIX;
    const handle = await fs.open(tmp, "w");
    try {
      await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, this.indexPath);
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function assertSafeId(value: string, label: string): string {
  if (!isUuidString(value)) {
    throw new Error(`${label} must be a UUID.`);
  }
  return value;
}

function assertSafeName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Attachment name is required.");
  }
  return path.basename(value.trim()).slice(0, 180);
}

function assertImageMimeType(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Only PNG, JPEG, WebP, and GIF images are supported.");
  }
  const normalized = normalizeSupportedAttachmentMimeType(value);
  if (!normalized) {
    throw new Error("Only PNG, JPEG, WebP, and GIF images are supported.");
  }
  return normalized;
}

function decodeBase64(value: unknown): Buffer {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Attachment dataBase64 is required.");
  }
  const normalized = value.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error("Attachment dataBase64 must be valid base64.");
  }
  const data = Buffer.from(normalized, "base64");
  if (data.byteLength === 0 || data.toString("base64") !== normalized) {
    throw new Error("Attachment dataBase64 must be valid base64.");
  }
  return data;
}

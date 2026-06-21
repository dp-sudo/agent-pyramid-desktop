import { isIsoTimestampString, isUuidString } from "./contract-primitives.js";

export interface AttachmentRecord {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface AttachmentCreateRequest {
  name: string;
  mimeType: string;
  dataBase64: string;
}

export const SUPPORTED_ATTACHMENT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
export type SupportedAttachmentMimeType = (typeof SUPPORTED_ATTACHMENT_MIME_TYPES)[number];
export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
export const MAX_ATTACHMENT_NAME_LENGTH = 180;

export function normalizeSupportedAttachmentMimeType(
  mimeType: string,
): SupportedAttachmentMimeType | null {
  const normalized = mimeType.trim().toLowerCase();
  return SUPPORTED_ATTACHMENT_MIME_TYPES.includes(normalized as SupportedAttachmentMimeType)
    ? (normalized as SupportedAttachmentMimeType)
    : null;
}

export function normalizeAttachmentName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const segments = trimmed.split(/[\\/]+/u).filter(Boolean);
  const basename = segments.length > 0 ? segments[segments.length - 1] ?? "" : "";
  const normalized = basename.slice(0, MAX_ATTACHMENT_NAME_LENGTH);
  return isNormalizedAttachmentRecordName(normalized) ? normalized : null;
}

export function isAttachmentRecord(value: unknown): value is AttachmentRecord {
  if (!isRecord(value)) return false;
  const size = value.size;
  return isUuidString(value.id) &&
    isAttachmentRecordName(value.name) &&
    typeof value.mimeType === "string" &&
    normalizeSupportedAttachmentMimeType(value.mimeType) !== null &&
    typeof size === "number" &&
    Number.isInteger(size) &&
    size > 0 &&
    size <= MAX_ATTACHMENT_BYTES &&
    isIsoTimestampString(value.createdAt);
}

export interface AttachmentDeleteRequest {
  id: string;
}

export interface AttachmentDeleteResponse {
  id: string;
}

function isAttachmentRecordName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return isNormalizedAttachmentRecordName(value);
}

function isNormalizedAttachmentRecordName(value: string): boolean {
  return value.length > 0 &&
    value.length <= MAX_ATTACHMENT_NAME_LENGTH &&
    value === value.trim() &&
    value !== "." &&
    value !== ".." &&
    !/[\\/]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

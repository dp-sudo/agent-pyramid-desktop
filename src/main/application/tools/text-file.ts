import {
  constants as fsConstants,
  promises as fs,
} from "node:fs";
import { TextDecoder } from "node:util";

const STRICT_UTF8_DECODER_OPTIONS = {
  fatal: true,
  ignoreBOM: true,
} as const;

const UTF8_DECODER = new TextDecoder("utf-8", STRICT_UTF8_DECODER_OPTIONS);

type TextFileHandle = Awaited<ReturnType<typeof fs.open>>;

export interface Utf8TextStreamValidator {
  push(chunk: Uint8Array): void;
  finish(): void;
}

export interface Utf8TextPrefix {
  content: string;
  bytesDecoded: number;
}

export interface WriteUtf8TextFileNoFollowOptions {
  exclusive?: boolean;
  label: string;
  relativePath: string;
}

export interface OpenTextFileNoFollowOptions {
  label: string;
  relativePath: string;
}

/**
 * Workspace coding tools operate on UTF-8 text. Fatal decoding keeps invalid
 * byte sequences from being converted to replacement characters and then
 * written back as apparently valid source text.
 */
export function decodeUtf8TextBuffer(
  buffer: Uint8Array,
  relativePath: string,
  label: string,
): string {
  if (buffer.includes(0)) {
    throw new Error(`${label} appears to be binary: ${relativePath}`);
  }
  try {
    return UTF8_DECODER.decode(buffer);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8: ${relativePath}`, {
      cause: error,
    });
  }
}

export function assertUtf8TextBuffer(
  buffer: Uint8Array,
  relativePath: string,
  label: string,
): void {
  void decodeUtf8TextBuffer(buffer, relativePath, label);
}

/**
 * Read-side endpoints need the same final-component symlink protection as
 * writes: the workspace realpath policy verifies the path before access, and
 * O_NOFOLLOW binds the last component to the actual open operation. On
 * platforms where O_NOFOLLOW is unavailable (Windows), an attacker can still
 * swap the final component to a symlink between validation and the open call;
 * the post-open lstat recheck closes that window by detecting the swap.
 */
export async function openTextFileNoFollow(
  filePath: string,
  options: OpenTextFileNoFollowOptions,
): Promise<TextFileHandle> {
  const useNoFollowFlag = noFollowFlag();
  try {
    const handle = await fs.open(filePath, fsConstants.O_RDONLY | useNoFollowFlag);
    try {
      if (useNoFollowFlag === 0) {
        await assertOpenedTargetNotSymlink(filePath, options);
      }
      return handle;
    } catch (error) {
      try {
        await handle.close();
      } catch (closeError) {
        throw new Error(
          `${messageOf(error)}; close failed: ${messageOf(closeError)}`,
          { cause: error },
        );
      }
      throw error;
    }
  } catch (error) {
    if (getNodeErrorCode(error) === "ELOOP") {
      throw new Error(`${options.label} target is a symbolic link: ${options.relativePath}`);
    }
    throw error;
  }
}

/**
 * Final write commits must not follow a target symlink that appears after the
 * workspace realpath/lstat checks. O_NOFOLLOW binds the last path component to
 * the open operation on supporting platforms. On platforms without it (Windows)
 * fs.open silently follows a swapped symlink, and O_TRUNC would truncate the
 * linked target before any guard can run, so there we open without O_TRUNC,
 * re-lstat to detect the swap, and only then truncate+write once the target is
 * confirmed to be a regular file the workspace policy already approved.
 */
export async function writeUtf8TextFileNoFollow(
  filePath: string,
  content: string,
  options: WriteUtf8TextFileNoFollowOptions,
): Promise<void> {
  const useNoFollowFlag = noFollowFlag();
  const noFollowSupported = useNoFollowFlag !== 0;
  // POSIX keeps O_TRUNC in the open flags (O_NOFOLLOW rejects a symlink atomically
  // before any truncation). On Windows we defer truncation until after the
  // post-open lstat guard so a swapped-symlink target is never truncated.
  const flags = fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    useNoFollowFlag |
    (options.exclusive
      ? fsConstants.O_EXCL
      : noFollowSupported
        ? fsConstants.O_TRUNC
        : 0);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, flags, 0o666);
    if (!noFollowSupported) {
      await assertOpenedTargetNotSymlink(filePath, options);
      await handle.truncate(0);
    }
    await handle.writeFile(content, "utf8");
  } catch (error) {
    if (getNodeErrorCode(error) === "ELOOP") {
      throw new Error(`${options.label} target is a symbolic link: ${options.relativePath}`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * Fallback symlink guard for platforms where O_NOFOLLOW is unavailable (e.g.
 * Windows, where fsConstants.O_NOFOLLOW is undefined). fs.open follows the
 * symlink silently in that case, so after a successful open we re-stat the path
 * without following: if the final component is now a symlink, the target was
 * swapped between workspace validation and the open, and the operation must be
 * rejected with the same traceable error as the O_NOFOLLOW path. lstat is a
 * no-op cost on POSIX (useNoFollowFlag is non-zero there, so this is skipped).
 */
async function assertOpenedTargetNotSymlink(
  filePath: string,
  options: { label: string; relativePath: string },
): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    // ENOENT between open and lstat is a benign race for a removed entry; any
    // other failure must surface rather than be hidden as a safe access.
    if (getNodeErrorCode(error) === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`${options.label} target is a symbolic link: ${options.relativePath}`);
  }
}

export function decodeUtf8TextPrefix(
  buffer: Uint8Array,
  relativePath: string,
  label: string,
): Utf8TextPrefix {
  try {
    return {
      content: decodeUtf8TextBuffer(buffer, relativePath, label),
      bytesDecoded: buffer.byteLength,
    };
  } catch (error) {
    const incompleteBytes = trailingIncompleteUtf8SequenceByteCount(buffer);
    if (incompleteBytes <= 0) {
      throw error;
    }
    const completePrefix = buffer.subarray(0, buffer.byteLength - incompleteBytes);
    return {
      content: decodeUtf8TextBuffer(completePrefix, relativePath, label),
      bytesDecoded: completePrefix.byteLength,
    };
  }
}

export function createUtf8TextStreamValidator(
  relativePath: string,
  label: string,
): Utf8TextStreamValidator {
  const decoder = new TextDecoder("utf-8", STRICT_UTF8_DECODER_OPTIONS);
  return {
    push(chunk) {
      if (chunk.includes(0)) {
        throw new Error(`${label} appears to be binary: ${relativePath}`);
      }
      try {
        void decoder.decode(chunk, { stream: true });
      } catch (error) {
        throw new Error(`${label} is not valid UTF-8: ${relativePath}`, {
          cause: error,
        });
      }
    },
    finish() {
      try {
        void decoder.decode();
      } catch (error) {
        throw new Error(`${label} is not valid UTF-8: ${relativePath}`, {
          cause: error,
        });
      }
    },
  };
}

function trailingIncompleteUtf8SequenceByteCount(buffer: Uint8Array): number {
  if (buffer.byteLength === 0) return 0;
  let continuationCount = 0;
  for (
    let index = buffer.byteLength - 1;
    index >= 0 && isUtf8ContinuationByte(buffer[index]);
    index -= 1
  ) {
    continuationCount += 1;
  }

  const leadIndex = buffer.byteLength - continuationCount - 1;
  if (leadIndex < 0) return 0;
  const lead = buffer[leadIndex];
  const requiredLength = utf8SequenceLength(lead);
  if (requiredLength === 0) return 0;

  const availableLength = buffer.byteLength - leadIndex;
  if (availableLength >= requiredLength) return 0;
  if (continuationCount !== availableLength - 1) return 0;
  if (!hasValidUtf8PrefixBytes(buffer, leadIndex, requiredLength)) return 0;
  return availableLength;
}

function utf8SequenceLength(lead: number | undefined): number {
  if (lead === undefined) return 0;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

function hasValidUtf8PrefixBytes(
  buffer: Uint8Array,
  leadIndex: number,
  requiredLength: number,
): boolean {
  const lead = buffer[leadIndex];
  const second = buffer[leadIndex + 1];
  if (second === undefined) return true;
  if (!isUtf8ContinuationByte(second)) return false;
  if (requiredLength === 3) {
    if (lead === 0xe0) return second >= 0xa0 && second <= 0xbf;
    if (lead === 0xed) return second >= 0x80 && second <= 0x9f;
  }
  if (requiredLength === 4) {
    if (lead === 0xf0) return second >= 0x90 && second <= 0xbf;
    if (lead === 0xf4) return second >= 0x80 && second <= 0x8f;
  }
  return true;
}

function isUtf8ContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
}

function noFollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
}

function getNodeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { TextDecoder } from "node:util";

const STRICT_UTF8_DECODER_OPTIONS = {
  fatal: true,
  ignoreBOM: true,
} as const;

const UTF8_DECODER = new TextDecoder("utf-8", STRICT_UTF8_DECODER_OPTIONS);

export interface Utf8TextStreamValidator {
  push(chunk: Uint8Array): void;
  finish(): void;
}

export interface Utf8TextPrefix {
  content: string;
  bytesDecoded: number;
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

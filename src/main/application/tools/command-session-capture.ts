import { StringDecoder } from "node:string_decoder";
import type { StreamCapture } from "./command-output-capture.js";

export interface SessionCapture {
  collect(data: Buffer | string): void;
  snapshot(tailBytes: number): StreamCapture;
}

export function createSessionCapture(maxOutputBytes: number): SessionCapture {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let storedBytes = 0;
  let truncated = false;
  return {
    collect(data) {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      bytes += buffer.length;
      chunks.push(buffer);
      storedBytes += buffer.length;
      // Long-running sessions are read by tail, so the bounded buffer keeps the
      // newest bytes instead of freezing at the first max_buffer_bytes output.
      while (storedBytes > maxOutputBytes && chunks.length > 0) {
        truncated = true;
        const overflow = storedBytes - maxOutputBytes;
        const first = chunks[0];
        if (overflow >= first.length) {
          chunks.shift();
          storedBytes -= first.length;
          continue;
        }
        chunks[0] = first.subarray(overflow);
        storedBytes -= overflow;
      }
    },
    snapshot(tailBytes) {
      const fullBuffer = Buffer.concat(chunks, storedBytes);
      const start = Math.max(0, fullBuffer.byteLength - tailBytes);
      const buffer = dropLeadingUtf8ContinuationBytes(fullBuffer.subarray(start));
      const decoder = new StringDecoder("utf8");
      return {
        text: decoder.write(buffer),
        bytes,
        truncated: truncated || start > 0,
      };
    },
  };
}

export function dropLeadingUtf8ContinuationBytes(buffer: Buffer): Buffer {
  // tail_bytes can start inside a multi-byte UTF-8 sequence; discard only the
  // orphaned continuation bytes so snapshots stay valid without widening output.
  let index = 0;
  while (index < buffer.length && (buffer[index] & 0b1100_0000) === 0b1000_0000) {
    index += 1;
  }
  return index === 0 ? buffer : buffer.subarray(index);
}

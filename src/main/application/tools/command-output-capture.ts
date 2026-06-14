import { StringDecoder } from "node:string_decoder";

export interface StreamCapture {
  text: string;
  bytes: number;
  truncated: boolean;
}

export function createOutputCollector(maxOutputBytes: number): {
  collect(data: Buffer | string): void;
  finish(): StreamCapture;
} {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let storedBytes = 0;
  let truncated = false;

  return {
    collect(data) {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      bytes += buffer.length;
      const remaining = maxOutputBytes - storedBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (buffer.length > remaining) {
        chunks.push(buffer.subarray(0, remaining));
        storedBytes += remaining;
        truncated = true;
        return;
      }
      chunks.push(buffer);
      storedBytes += buffer.length;
    },
    finish() {
      const decoder = new StringDecoder("utf8");
      const buffer = Buffer.concat(chunks, storedBytes);
      const text = decoder.write(buffer) + (truncated ? "" : decoder.end());
      return {
        text,
        bytes,
        truncated,
      };
    },
  };
}

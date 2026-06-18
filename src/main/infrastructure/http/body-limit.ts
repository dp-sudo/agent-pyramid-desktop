const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

/**
 * Reads fetch bodies through the stream reader and aborts once the byte budget
 * is exceeded. This keeps provider/MCP error bodies from being fully buffered
 * before size checks can run.
 */
export async function readResponseTextBounded(
  response: Response,
  maxBytes: number,
  errorMessage: string,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel(errorMessage);
        throw new Error(errorMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return TEXT_DECODER.decode(data);
}

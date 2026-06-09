import { describe, expect, it } from "vitest";
import {
  classifyWorkerErrorCode,
  createWorkerRawStreamSummary,
  normalizeWorkerErrorCode,
  recordWorkerRawStreamChunk,
} from "../../../src/main/infrastructure/llm-worker/worker-diagnostics";

describe("worker diagnostics", () => {
  it("classifies provider HTTP and schema errors", () => {
    expect(
      classifyWorkerErrorCode(
        new Error("LLM openai-compatible stream failed with HTTP 429: rate limited"),
      ),
    ).toBe("http");
    expect(
      classifyWorkerErrorCode(
        new Error("LLM stream frame was not valid JSON: Unexpected token"),
      ),
    ).toBe("schema");
    expect(classifyWorkerErrorCode(new Error("worker connection lost"))).toBe("internal");
    expect(normalizeWorkerErrorCode("schema")).toBe("schema");
    expect(normalizeWorkerErrorCode("bad-code")).toBe("internal");
  });

  it("records bounded raw stream summaries without retaining delta text", () => {
    const summary = createWorkerRawStreamSummary();

    for (let index = 0; index < summary.sampleLimit + 2; index += 1) {
      recordWorkerRawStreamChunk(summary, {
        kind: "text_delta",
        text: `large-text-${index}`,
      });
    }

    expect(summary.chunkCount).toBe(summary.sampleLimit + 2);
    expect(summary.samples).toHaveLength(summary.sampleLimit);
    expect(summary.truncatedSamples).toBe(2);
    expect(summary.samples[0]).toEqual({ kind: "text_delta", textLength: 12 });
  });
});

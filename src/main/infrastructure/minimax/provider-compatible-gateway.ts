import type {
  LlmGateway,
  LlmRequest,
  LlmResponse,
  LlmStreamChunk,
  LlmStreamOptions,
} from "../../domain/agent/types";
import {
  completeAnthropicCompatible,
  streamAnthropicCompatible,
} from "./anthropic-compatible-adapter.js";
import {
  completeOpenAiCompatible,
  streamOpenAiCompatible,
} from "./openai-compatible-adapter.js";

export class ProviderCompatibleGateway implements LlmGateway {
  async complete(request: LlmRequest): Promise<LlmResponse> {
    if (request.protocol === "openai-compatible") {
      return completeOpenAiCompatible(request);
    }

    return completeAnthropicCompatible(request);
  }

  async *stream(
    request: LlmRequest,
    options: LlmStreamOptions = {},
  ): AsyncIterable<LlmStreamChunk> {
    if (request.protocol === "openai-compatible") {
      yield* streamOpenAiCompatible(request, options);
      return;
    }

    yield* streamAnthropicCompatible(request, options);
  }
}

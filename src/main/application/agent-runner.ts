import type { AgentRunRequest, AgentRunResponse } from "../../shared/agent-contracts";
import { TriangleTrace } from "../core/triangle-loop";
import type { ToolRegistry } from "../domain/agent/ports";
import type { AgentMessage, LlmGateway } from "../domain/agent/types";

export class AgentRunner {
  constructor(
    private readonly llmGateway: LlmGateway,
    private readonly toolRegistry: ToolRegistry
  ) {}

  async run(request: AgentRunRequest): Promise<AgentRunResponse> {
    const trace = new TriangleTrace();
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: request.goal
      }
    ];

    trace.record({
      stage: "observe",
      title: "Task observed",
      detail: request.goal
    });

    const firstResponse = await this.llmGateway.complete({
      protocol: request.protocol,
      model: request.model,
      apiKey: request.apiKey,
      systemPrompt: request.systemPrompt,
      messages,
      tools: this.toolRegistry.listDefinitions(),
      maxTokens: request.maxTokens,
      temperature: request.temperature
    });

    trace.record({
      stage: "reason",
      title: "Model response received",
      detail: firstResponse.text || firstResponse.reasoning || "Model returned no text content."
    });

    if (firstResponse.toolCalls.length === 0) {
      trace.record({
        stage: "act",
        title: "No tool action required",
        detail: "The model completed without requesting a tool."
      });

      return {
        status: "completed",
        output: firstResponse.text,
        reasoning: firstResponse.reasoning,
        trace: trace.snapshot(),
        usage: firstResponse.usage
      };
    }

    const toolResults = [];
    for (const call of firstResponse.toolCalls) {
      const result = await this.toolRegistry.execute(call);
      toolResults.push(result);
      trace.record({
        stage: "act",
        title: `Tool executed: ${result.name}`,
        detail: result.content
      });
    }

    const followUpMessages: AgentMessage[] = [
      ...messages,
      {
        role: "assistant",
        content: firstResponse.text
      },
      ...toolResults.map<AgentMessage>((result) => ({
        role: "tool",
        content: result.content,
        toolCallId: result.toolCallId
      }))
    ];

    const finalResponse = await this.llmGateway.complete({
      protocol: request.protocol,
      model: request.model,
      apiKey: request.apiKey,
      systemPrompt: request.systemPrompt,
      messages: followUpMessages,
      tools: this.toolRegistry.listDefinitions(),
      maxTokens: request.maxTokens,
      temperature: request.temperature
    });

    trace.record({
      stage: "reason",
      title: "Final response received",
      detail: finalResponse.text || finalResponse.reasoning || "Model returned no final text content."
    });

    return {
      status: "completed",
      output: finalResponse.text,
      reasoning: finalResponse.reasoning,
      trace: trace.snapshot(),
      usage: finalResponse.usage
    };
  }
}

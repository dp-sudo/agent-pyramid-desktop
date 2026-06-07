import type { ToolRegistry } from "../../domain/agent/ports";
import type { AgentTool, AgentToolCall, AgentToolResult } from "../../domain/agent/types";

export class InMemoryToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  constructor(tools: AgentTool[]) {
    for (const tool of tools) {
      this.tools.set(tool.definition.name, tool);
    }
  }

  listDefinitions(): AgentTool["definition"][] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  async execute(call: AgentToolCall): Promise<AgentToolResult> {
    const tool = this.tools.get(call.name);

    if (!tool) {
      throw new Error(`Tool "${call.name}" is not registered.`);
    }

    const content = await tool.execute(call.arguments);

    return {
      toolCallId: call.id,
      name: call.name,
      content
    };
  }
}

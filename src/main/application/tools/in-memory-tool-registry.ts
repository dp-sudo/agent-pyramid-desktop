import type { ToolRegistry } from "../../domain/agent/ports";
import type {
  AgentTool,
  AgentToolCall,
  AgentToolContext,
  AgentToolResult,
} from "../../domain/agent/types";

export class InMemoryToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  constructor(tools: AgentTool[]) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  register(tool: AgentTool): void {
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`Tool "${tool.definition.name}" is already registered.`);
    }
    this.tools.set(tool.definition.name, tool);
  }

  listDefinitions(): AgentTool["definition"][] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  async execute(call: AgentToolCall, context: AgentToolContext): Promise<AgentToolResult> {
    const tool = this.tools.get(call.name);

    if (!tool) {
      throw new Error(`Tool "${call.name}" is not registered.`);
    }

    const content = await tool.execute(call.arguments, context);

    return {
      toolCallId: call.id,
      name: call.name,
      content
    };
  }
}

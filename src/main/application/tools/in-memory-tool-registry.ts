import type { ToolRegistry } from "../../domain/agent/ports";
import type {
  AgentTool,
  AgentToolCall,
  AgentToolContext,
  AgentToolResult,
} from "../../domain/agent/types";
import { validateToolInputSchema } from "./tool-schema.js";

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

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  listDefinitions(): AgentTool["definition"][] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  getTool(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  async execute(call: AgentToolCall, context: AgentToolContext): Promise<AgentToolResult> {
    const tool = this.tools.get(call.name);

    if (!tool) {
      throw new Error(`Tool "${call.name}" is not registered.`);
    }

    validateToolInputSchema(tool.definition.name, tool.definition.inputSchema, call.arguments);
    const result = await tool.execute(call.arguments, context);
    if (typeof result !== "string") {
      return {
        ...result,
        toolCallId: call.id,
        name: call.name,
      };
    }

    return {
      toolCallId: call.id,
      name: call.name,
      content: result,
    };
  }
}

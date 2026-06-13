import type { AgentTool, AgentToolCall, AgentToolContext, AgentToolResult } from "./types";

export interface ToolRegistry {
  listDefinitions(): AgentTool["definition"][];
  getTool(name: string): AgentTool | undefined;
  register(tool: AgentTool): void;
  unregister(name: string): boolean;
  execute(call: AgentToolCall, context: AgentToolContext): Promise<AgentToolResult>;
}

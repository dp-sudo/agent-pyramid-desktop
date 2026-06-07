import type { AgentTool, AgentToolCall, AgentToolContext, AgentToolResult } from "./types";

export interface ToolRegistry {
  listDefinitions(): AgentTool["definition"][];
  execute(call: AgentToolCall, context: AgentToolContext): Promise<AgentToolResult>;
}

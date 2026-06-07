import type { AgentTool, AgentToolCall, AgentToolResult } from "./types";

export interface ToolRegistry {
  listDefinitions(): AgentTool["definition"][];
  execute(call: AgentToolCall): Promise<AgentToolResult>;
}

import type { ToolRegistry } from "../domain/agent/ports.js";
import type { AgentToolCall } from "../domain/agent/types.js";

const SERIAL_TOOL_NAMES = new Set(["run_skill", "request_user_input"]);

export function canExecuteToolCallsInParallel(
  registry: Pick<ToolRegistry, "getTool">,
  calls: readonly AgentToolCall[],
): boolean {
  return calls.length > 1 &&
    calls.every((call) => isParallelSafeReadOnlyToolCall(registry, call));
}

export function isParallelSafeReadOnlyToolCall(
  registry: Pick<ToolRegistry, "getTool">,
  call: AgentToolCall,
): boolean {
  const tool = registry.getTool(call.name);
  if (!tool?.metadata?.isReadOnly) return false;
  // run_skill dispatches another LLM loop; request_user_input suspends for a
  // human response. Both need ordered execution even when their metadata is read-only.
  return !SERIAL_TOOL_NAMES.has(call.name);
}

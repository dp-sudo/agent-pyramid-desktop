import type { ToolRegistry } from "../domain/agent/ports.js";
import type { AgentToolCall } from "../domain/agent/types.js";
import type {
  RuntimePreferences,
  ThreadRecord,
  TurnRecord,
} from "../../shared/agent-contracts.js";
import { evaluatePermission } from "./permission-policy.js";

export type ToolPolicyDecision = "allow" | "ask" | "deny";

export interface ToolPolicyInput {
  call: AgentToolCall;
  turn: TurnRecord;
  thread: ThreadRecord;
  runtimePreferences: RuntimePreferences;
  isToolAvailable: boolean;
}

export class ToolPolicyService {
  constructor(private readonly registry: ToolRegistry) {}

  /**
   * Resolves execution policy immediately before a tool runs. Catalog
   * availability is supplied by ToolCatalogService; sandbox and approval
   * denials stay authoritative before configurable permission-rule shortcuts.
   */
  resolve(input: ToolPolicyInput): ToolPolicyDecision {
    const name = input.call.name;
    const tool = this.registry.getTool(name);
    if (!tool) {
      return "deny";
    }
    if (tool.metadata?.isReadOnly) {
      return "allow";
    }
    if (
      (name === "create_plan" || name === "update_goal") &&
      input.isToolAvailable
    ) {
      return "allow";
    }
    if (input.thread.sandboxMode === "read-only") {
      return "deny";
    }
    if (input.thread.approvalPolicy === "never") {
      return "deny";
    }
    const permissionDecision = evaluatePermission({
      toolName: name,
      args: input.call.arguments,
      rules: input.runtimePreferences.permissionRules,
    });
    if (permissionDecision !== "none") {
      return permissionDecision;
    }
    if (input.thread.approvalPolicy === "auto" && tool.metadata?.isDestructive === false) {
      return "allow";
    }
    return "ask";
  }
}

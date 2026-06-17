import type { ToolRegistry } from "../domain/agent/ports.js";
import type { AgentTool, AgentToolCall } from "../domain/agent/types.js";
import type {
  RuntimePreferences,
  RuntimePermissionRule,
  ThreadRecord,
  TurnRecord,
} from "../../shared/agent-contracts.js";
import { evaluatePermission } from "./permission-policy.js";
import { isSamePath } from "./path-utils.js";

export type ToolPolicyDecision = "allow" | "ask" | "deny";
type PermissionDecision = ToolPolicyDecision | "none";

export interface ToolPolicyInput {
  call: AgentToolCall;
  turn: TurnRecord;
  thread: ThreadRecord;
  runtimePreferences: RuntimePreferences;
  isToolAvailable: boolean;
  scopedPermissionRules?: readonly RuntimePreferences["permissionRules"][number][];
}

export class ToolPolicyService {
  constructor(private readonly registry: ToolRegistry) {}

  /**
   * Resolves execution policy immediately before a tool runs. The ordering is
   * the safety contract: catalog availability is supplied by ToolCatalogService,
   * sandbox/never are hard execution constraints, and per-call rules are only
   * approval shortcuts that cannot weaken those constraints.
   */
  resolve(input: ToolPolicyInput): ToolPolicyDecision {
    const name = input.call.name;
    const tool = this.registry.getTool(name);
    if (!tool) {
      return "deny";
    }
    if (tool.metadata?.isReadOnly) {
      return resolveReadOnlyPermissionDecision(input);
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

    const permissionDecision = evaluateCombinedPermission({
      toolName: name,
      args: input.call.arguments,
      workspace: input.thread.workspace,
      scopedRules: input.scopedPermissionRules ?? [],
      persistedRules: input.runtimePreferences.permissionRules,
    });
    if (permissionDecision === "deny" || permissionDecision === "ask") {
      return permissionDecision;
    }
    if (permissionDecision === "allow" && input.thread.approvalPolicy !== "untrusted") {
      return "allow";
    }
    if (input.thread.approvalPolicy === "auto" && canAutoApproveTool(tool.metadata)) {
      return "allow";
    }
    return "ask";
  }
}

function evaluateCombinedPermission(input: {
  toolName: string;
  args: Record<string, unknown>;
  workspace: string;
  scopedRules: readonly RuntimePermissionRule[];
  persistedRules: readonly RuntimePermissionRule[];
}): PermissionDecision {
  return evaluatePermission({
    toolName: input.toolName,
    args: input.args,
    rules: [...input.scopedRules, ...input.persistedRules]
      .filter((rule) => isPermissionRuleInWorkspace(rule, input.workspace)),
  });
}

function isPermissionRuleInWorkspace(rule: RuntimePermissionRule, workspace: string): boolean {
  if (!rule.scope) return true;
  return rule.scope.kind === "workspace" && isSamePath(rule.scope.workspace, workspace);
}

function resolveReadOnlyPermissionDecision(input: ToolPolicyInput): ToolPolicyDecision {
  const permissionDecision = evaluateCombinedPermission({
    toolName: input.call.name,
    args: input.call.arguments,
    workspace: input.thread.workspace,
    scopedRules: input.scopedPermissionRules ?? [],
    persistedRules: input.runtimePreferences.permissionRules,
  });
  if (permissionDecision === "deny") {
    return "deny";
  }
  if (permissionDecision === "ask") {
    return input.thread.approvalPolicy === "never" ? "deny" : "ask";
  }
  return "allow";
}

function canAutoApproveTool(metadata: AgentTool["metadata"]): boolean {
  return metadata?.isDestructive === false;
}

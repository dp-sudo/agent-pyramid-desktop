import { createHash } from "node:crypto";
import type { ToolRegistry } from "../domain/agent/ports.js";
import type { AgentToolDefinition } from "../domain/agent/types.js";
import type {
  RuntimePreferences,
  RuntimeToolCatalogSnapshot,
  RuntimeToolName,
  ThreadRecord,
  TurnRecord,
} from "../../shared/agent-contracts.js";
import { THREAD_MODES, isRuntimeToolName } from "../../shared/agent-contracts.js";

export type ToolAccessDecision = "allow" | "deny" | "inherit";

export interface ToolAccessPolicyInput {
  name: string;
  turn: TurnRecord;
  thread: ThreadRecord;
  definition?: AgentToolDefinition;
}

export type ToolAccessPolicy = (input: ToolAccessPolicyInput) => ToolAccessDecision;

export interface ToolAccessPolicyConfig {
  allowByMode?: Partial<Record<ThreadRecord["mode"], readonly string[]>>;
  denyByMode?: Partial<Record<ThreadRecord["mode"], readonly string[]>>;
}

export const COMMAND_TOOL_NAMES = [
  "run_command",
  "shell_command",
  "git_bash_command",
  "powershell_command",
  "wsl_command",
  "git_status",
  "git_diff",
  "git_log",
  "git_branch",
  "git_commit",
  "package_scripts",
  "package_install",
  "package_test",
  "package_build",
  "run_lint",
  "run_format",
  "run_tests",
  "run_build",
  "start_command_session",
  "list_command_sessions",
  "read_command_session",
  "write_command_session",
  "stop_command_session",
  "detect_shell_environment",
  "diagnose_workspace",
  "diagnose_file",
] as const satisfies readonly RuntimeToolName[];

const COMMAND_TOOL_NAME_SET = new Set<string>(COMMAND_TOOL_NAMES);

export const CODE_ONLY_TOOL_NAMES = [
  "edit_file",
  "multi_edit",
  "write_file",
  "delete_file",
  "apply_patch",
  "rollback_file",
  ...COMMAND_TOOL_NAMES,
] as const satisfies readonly RuntimeToolName[];

const CODE_ONLY_TOOL_NAME_SET = new Set<string>(CODE_ONLY_TOOL_NAMES);
const DEFAULT_TOOL_ACCESS_POLICY = createToolAccessPolicy({
  denyByMode: {
    write: CODE_ONLY_TOOL_NAMES,
  },
});

const MCP_TOOL_NAME_PREFIX = "mcp__";

export function isCodeOnlyToolName(name: string): boolean {
  return CODE_ONLY_TOOL_NAME_SET.has(name);
}

export function isCommandToolName(name: string): boolean {
  return COMMAND_TOOL_NAME_SET.has(name);
}

export function createToolAccessPolicy(config: ToolAccessPolicyConfig): ToolAccessPolicy {
  const allowByMode = toToolAccessSets(config.allowByMode);
  const denyByMode = toToolAccessSets(config.denyByMode);
  assertNoToolAccessConflicts(allowByMode, denyByMode);
  return ({ name, thread }) => {
    if (allowByMode[thread.mode]?.has(name)) return "allow";
    if (denyByMode[thread.mode]?.has(name)) return "deny";
    return "inherit";
  };
}

function toToolAccessSets(
  config: Partial<Record<ThreadRecord["mode"], readonly string[]>> | undefined,
): Partial<Record<ThreadRecord["mode"], ReadonlySet<string>>> {
  return {
    ...(config?.code ? { code: new Set(config.code) } : {}),
    ...(config?.write ? { write: new Set(config.write) } : {}),
  };
}

function assertNoToolAccessConflicts(
  allowByMode: Partial<Record<ThreadRecord["mode"], ReadonlySet<string>>>,
  denyByMode: Partial<Record<ThreadRecord["mode"], ReadonlySet<string>>>,
): void {
  for (const mode of THREAD_MODES) {
    const allow = allowByMode[mode];
    const deny = denyByMode[mode];
    if (!allow || !deny) {
      continue;
    }
    for (const name of allow) {
      if (deny.has(name)) {
        throw new Error(`Tool access policy conflict for ${mode}:${name}.`);
      }
    }
  }
}

export interface ToolCatalogServiceDeps {
  registry: ToolRegistry;
  toolAccessPolicy?: ToolAccessPolicy;
}

export class ToolCatalogService {
  constructor(private readonly deps: ToolCatalogServiceDeps) {}

  /**
   * Produces the model-visible tool catalog for a turn. This is catalog access
   * only: approval, sandbox, and permission-rule checks still run immediately
   * before execution so forced model calls cannot bypass policy.
   */
  listDefinitionsForTurn(
    turn: TurnRecord,
    thread: ThreadRecord,
    runtimePreferences: RuntimePreferences,
  ): AgentToolDefinition[] {
    return this.deps.registry
      .listDefinitions()
      .filter((definition) =>
        this.isToolEnabledForTurn(
          definition.name,
          turn,
          thread,
          runtimePreferences,
          definition,
        ),
      )
      .sort(compareToolDefinitions);
  }

  describeDefinitions(definitions: AgentToolDefinition[]): RuntimeToolCatalogSnapshot {
    const normalized = normalizeToolDefinitions(definitions);
    return {
      fingerprint: hashToolCatalog(normalized),
      toolCount: normalized.length,
      toolNames: normalized.map((definition) => definition.name),
    };
  }

  isToolAvailableForTurn(
    name: string,
    turn: TurnRecord,
    thread: ThreadRecord,
    runtimePreferences: RuntimePreferences,
  ): boolean {
    return this.listDefinitionsForTurn(turn, thread, runtimePreferences).some(
      (definition) => definition.name === name,
    );
  }

  private isToolEnabledForTurn(
    name: string,
    turn: TurnRecord,
    thread: ThreadRecord,
    runtimePreferences: RuntimePreferences,
    definition?: AgentToolDefinition,
  ): boolean {
    if (name === "create_plan") {
      return turn.mode === "plan" &&
        this.isToolAllowedByAccessPolicy(
          name,
          turn,
          thread,
          runtimePreferences,
          definition,
        );
    }
    if (name === "update_goal") {
      return Boolean(turn.goalMode || thread.goal?.status === "active") &&
        this.isToolAllowedByAccessPolicy(
          name,
          turn,
          thread,
          runtimePreferences,
          definition,
        );
    }
    return this.isToolAllowedByAccessPolicy(
      name,
      turn,
      thread,
      runtimePreferences,
      definition,
    );
  }

  private isToolAllowedByAccessPolicy(
    name: string,
    turn: TurnRecord,
    thread: ThreadRecord,
    runtimePreferences: RuntimePreferences,
    definition?: AgentToolDefinition,
  ): boolean {
    const input = { name, turn, thread, ...(definition ? { definition } : {}) };
    const configuredDecision = this.deps.toolAccessPolicy?.(input);
    if (configuredDecision === "allow") return true;
    if (configuredDecision === "deny") return false;
    if (isRuntimeToolName(name)) {
      return runtimePreferences.toolAvailability[thread.mode][name];
    }
    if (name.startsWith(MCP_TOOL_NAME_PREFIX)) {
      return thread.mode === "code";
    }
    return DEFAULT_TOOL_ACCESS_POLICY(input) !== "deny";
  }
}

function compareToolDefinitions(a: AgentToolDefinition, b: AgentToolDefinition): number {
  return a.name.localeCompare(b.name);
}

function normalizeToolDefinitions(definitions: AgentToolDefinition[]): AgentToolDefinition[] {
  return [...definitions]
    .map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: canonicalizeJson(definition.inputSchema) as Record<string, unknown>,
    }))
    .sort(compareToolDefinitions);
}

function hashToolCatalog(definitions: AgentToolDefinition[]): string {
  return createHash("sha256")
    .update(JSON.stringify(definitions))
    .digest("hex")
    .slice(0, 16);
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalizeJson((value as Record<string, unknown>)[key]);
  }
  return out;
}

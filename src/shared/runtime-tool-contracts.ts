export type RuntimeToolPolicyKind =
  | "read"
  | "write"
  | "command"
  | "conversation";
export type RuntimeToolTimelineAction =
  | "explore"
  | "read"
  | "modify"
  | "execute";

export interface RuntimeToolManifestEntry {
  name: string;
  policyKind: RuntimeToolPolicyKind;
  timelineAction: RuntimeToolTimelineAction;
  readOnly: boolean;
  codeDefaultEnabled: boolean;
  writeDefaultEnabled: boolean;
  codeOnly: boolean;
  commandTool: boolean;
  completionEvidence: "file_change" | "command" | null;
  permissionCandidate: "shell_command" | "generated_command" | "write_path" | "apply_patch" | null;
}

export const RUNTIME_TOOL_MANIFEST = [
  runtimeTool("list_files", "read", "explore", { readOnly: true, writeDefaultEnabled: true }),
  runtimeTool("read_file", "read", "read", { readOnly: true, writeDefaultEnabled: true }),
  runtimeTool("search_files", "read", "explore", { readOnly: true, writeDefaultEnabled: true }),
  runtimeTool("rg_search", "read", "explore", { readOnly: true, writeDefaultEnabled: true }),
  runtimeTool("list_symbols", "command", "read", { readOnly: true, codeOnly: true, commandTool: true }),
  runtimeTool("search_symbols", "command", "read", { readOnly: true, codeOnly: true, commandTool: true }),
  runtimeTool("create_edit_plan", "read", "read", { readOnly: true, codeOnly: true }),
  runtimeTool("edit_file", "write", "modify", { codeOnly: true, completionEvidence: "file_change", permissionCandidate: "write_path" }),
  runtimeTool("multi_edit", "write", "modify", { codeOnly: true, completionEvidence: "file_change", permissionCandidate: "write_path" }),
  runtimeTool("write_file", "write", "modify", { codeOnly: true, completionEvidence: "file_change", permissionCandidate: "write_path" }),
  runtimeTool("delete_file", "write", "modify", { codeOnly: true, completionEvidence: "file_change", permissionCandidate: "write_path" }),
  runtimeTool("apply_patch", "write", "modify", { codeOnly: true, completionEvidence: "file_change", permissionCandidate: "apply_patch" }),
  runtimeTool("rollback_file", "write", "modify", { codeOnly: true, completionEvidence: "file_change", permissionCandidate: "write_path" }),
  runtimeTool("run_command", "command", "execute", { codeOnly: true, commandTool: true, completionEvidence: "command", permissionCandidate: "shell_command" }),
  runtimeTool("shell_command", "command", "execute", { codeOnly: true, commandTool: true, completionEvidence: "command", permissionCandidate: "shell_command" }),
  runtimeTool("git_bash_command", "command", "execute", { codeOnly: true, commandTool: true, completionEvidence: "command", permissionCandidate: "shell_command" }),
  runtimeTool("powershell_command", "command", "execute", { codeOnly: true, commandTool: true, completionEvidence: "command", permissionCandidate: "shell_command" }),
  runtimeTool("wsl_command", "command", "execute", { codeOnly: true, commandTool: true, completionEvidence: "command", permissionCandidate: "shell_command" }),
  runtimeTool("git_status", "command", "execute", { readOnly: true, codeOnly: true, commandTool: true, completionEvidence: "command" }),
  runtimeTool("git_diff", "command", "execute", { readOnly: true, codeOnly: true, commandTool: true, completionEvidence: "command" }),
  runtimeTool("git_log", "command", "execute", { readOnly: true, codeOnly: true, commandTool: true, completionEvidence: "command" }),
  runtimeTool("git_branch", "command", "execute", { readOnly: true, codeOnly: true, commandTool: true, completionEvidence: "command" }),
  runtimeTool("git_commit", "command", "execute", { codeOnly: true, commandTool: true, completionEvidence: "command", permissionCandidate: "generated_command" }),
  runtimeTool("package_scripts", "command", "execute", { readOnly: true, codeOnly: true, commandTool: true }),
  runtimeTool("package_install", "command", "execute", { codeOnly: true, commandTool: true, completionEvidence: "command", permissionCandidate: "generated_command" }),
  runtimeTool("package_test", "command", "execute", { codeOnly: true, commandTool: true, completionEvidence: "command", permissionCandidate: "generated_command" }),
  runtimeTool("package_build", "command", "execute", { codeOnly: true, commandTool: true, completionEvidence: "command", permissionCandidate: "generated_command" }),
  runtimeTool("run_lint", "command", "execute", { codeOnly: true, commandTool: true, completionEvidence: "command", permissionCandidate: "generated_command" }),
  runtimeTool("run_format", "command", "execute", { codeOnly: true, commandTool: true, completionEvidence: "command", permissionCandidate: "generated_command" }),
  runtimeTool("run_tests", "command", "execute", { codeOnly: true, commandTool: true, completionEvidence: "command", permissionCandidate: "generated_command" }),
  runtimeTool("run_build", "command", "execute", { codeOnly: true, commandTool: true, completionEvidence: "command", permissionCandidate: "generated_command" }),
  runtimeTool("start_command_session", "command", "execute", { codeOnly: true, commandTool: true, completionEvidence: "command", permissionCandidate: "shell_command" }),
  runtimeTool("list_command_sessions", "command", "read", { readOnly: true, codeOnly: true, commandTool: true }),
  runtimeTool("read_command_session", "command", "execute", { readOnly: true, codeOnly: true, commandTool: true, completionEvidence: "command" }),
  runtimeTool("write_command_session", "command", "execute", { codeOnly: true, commandTool: true, completionEvidence: "command", permissionCandidate: "generated_command" }),
  runtimeTool("stop_command_session", "command", "execute", { codeOnly: true, commandTool: true, completionEvidence: "command", permissionCandidate: "generated_command" }),
  runtimeTool("detect_shell_environment", "command", "execute", { readOnly: true, codeOnly: true, commandTool: true }),
  runtimeTool("diagnose_workspace", "command", "read", { codeOnly: true, commandTool: true, completionEvidence: "command", permissionCandidate: "generated_command" }),
  runtimeTool("diagnose_file", "command", "read", { readOnly: true, codeOnly: true, commandTool: true, completionEvidence: "command" }),
  runtimeTool("list_skills", "conversation", "execute", { readOnly: true, writeDefaultEnabled: true }),
  runtimeTool("run_skill", "conversation", "execute", { readOnly: true, writeDefaultEnabled: true }),
  runtimeTool("request_user_input", "conversation", "execute", { readOnly: true, writeDefaultEnabled: true }),
  runtimeTool("create_plan", "conversation", "execute", { writeDefaultEnabled: true }),
  runtimeTool("update_goal", "conversation", "execute", { writeDefaultEnabled: true }),
] as const satisfies readonly RuntimeToolManifestEntry[];

export const RUNTIME_TOOL_NAMES = RUNTIME_TOOL_MANIFEST.map((tool) => tool.name);
export type RuntimeToolName = (typeof RUNTIME_TOOL_NAMES)[number];

export const RUNTIME_READ_ONLY_TOOL_NAMES = RUNTIME_TOOL_MANIFEST
  .filter((tool) => tool.readOnly)
  .map((tool) => tool.name);
export type RuntimeReadOnlyToolName = (typeof RUNTIME_READ_ONLY_TOOL_NAMES)[number];

export function isRuntimeToolName(value: unknown): value is RuntimeToolName {
  return typeof value === "string" && RUNTIME_TOOL_NAMES.includes(value as RuntimeToolName);
}

export function getRuntimeToolManifestEntry(
  name: string,
): RuntimeToolManifestEntry | undefined {
  return RUNTIME_TOOL_MANIFEST.find((tool) => tool.name === name);
}

export function isRuntimeToolReadOnly(name: string): boolean {
  return getRuntimeToolManifestEntry(name)?.readOnly ?? false;
}

export function isRuntimeToolCodeOnly(name: string): boolean {
  return getRuntimeToolManifestEntry(name)?.codeOnly ?? false;
}

export function isRuntimeToolCommand(name: string): boolean {
  return getRuntimeToolManifestEntry(name)?.commandTool ?? false;
}

export function getRuntimeToolTimelineAction(
  name: string,
): RuntimeToolTimelineAction | undefined {
  return getRuntimeToolManifestEntry(name)?.timelineAction;
}

export function getRuntimeToolCompletionEvidence(
  name: string,
): RuntimeToolManifestEntry["completionEvidence"] {
  return getRuntimeToolManifestEntry(name)?.completionEvidence ?? null;
}

export function getRuntimeToolPermissionCandidate(
  name: string,
): RuntimeToolManifestEntry["permissionCandidate"] {
  return getRuntimeToolManifestEntry(name)?.permissionCandidate ?? null;
}

function runtimeTool<const Name extends string>(
  name: Name,
  policyKind: RuntimeToolPolicyKind,
  timelineAction: RuntimeToolTimelineAction,
  options: Partial<Omit<RuntimeToolManifestEntry, "name" | "policyKind" | "timelineAction">> = {},
): RuntimeToolManifestEntry & { name: Name } {
  const codeOnly = options.codeOnly ?? false;
  return {
    name,
    policyKind,
    timelineAction,
    readOnly: options.readOnly ?? false,
    codeDefaultEnabled: options.codeDefaultEnabled ?? true,
    writeDefaultEnabled: options.writeDefaultEnabled ?? !codeOnly,
    codeOnly,
    commandTool: options.commandTool ?? false,
    completionEvidence: options.completionEvidence ?? null,
    permissionCandidate: options.permissionCandidate ?? null,
  };
}

const COMMAND_ENV_ALLOWLIST = new Set([
  "APPDATA",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "LOGNAME",
  "NODE_ENV",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "SHELL",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
]);

/**
 * Command tools run model-suggested processes, so child processes receive a
 * narrow allowlisted environment instead of inheriting arbitrary host variables.
 * This preserves shell/package-manager basics while preventing credentials with
 * project-specific names from leaking through black-list gaps.
 */
export function buildCommandEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || !isAllowedCommandEnvironmentName(name)) continue;
    environment[name] = value;
  }
  return environment;
}

export function isSensitiveEnvironmentName(name: string): boolean {
  return !isAllowedCommandEnvironmentName(name);
}

export function isAllowedCommandEnvironmentName(name: string): boolean {
  return COMMAND_ENV_ALLOWLIST.has(name.toUpperCase());
}

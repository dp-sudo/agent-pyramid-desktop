const ALWAYS_SAFE_ENV_NAMES = new Set([
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

const SENSITIVE_ENV_NAME_PATTERNS = [
  /(^|_)(ACCESS|API|APP|CLIENT|PRIVATE|REFRESH|SESSION)?_?KEY(_|$)/,
  /(^|_)(AUTH|BEARER|CREDENTIAL|CREDENTIALS|COOKIE|OAUTH|PASSWORD|PASSWD|SECRET|TOKEN)(_|$)/,
  /^(ANTHROPIC|DEEPSEEK|MINIMAX|OPENAI)(_|$)/,
  /^(AWS|AZURE|GCP|GOOGLE)_.*(KEY|SECRET|TOKEN|CREDENTIAL)/,
  /^(GITHUB|GITLAB|NPM|PYPI|SLACK|STRIPE|VERCEL)_.*(KEY|SECRET|TOKEN|PASSWORD)/,
];

/**
 * Command tools run model-suggested processes, so child processes receive an
 * explicit environment with credential-like variables removed. Non-sensitive
 * platform variables such as PATH, HOME, TEMP and ComSpec are preserved so
 * shells, Git and package managers still behave like normal workspace tools.
 */
export function buildCommandEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || isSensitiveEnvironmentName(name)) continue;
    environment[name] = value;
  }
  return environment;
}

export function isSensitiveEnvironmentName(name: string): boolean {
  const normalized = name.toUpperCase();
  if (ALWAYS_SAFE_ENV_NAMES.has(normalized)) {
    return false;
  }
  return SENSITIVE_ENV_NAME_PATTERNS.some((pattern) => pattern.test(normalized));
}

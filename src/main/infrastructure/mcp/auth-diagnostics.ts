import type { McpServerConfig } from "../../../shared/agent-contracts.js";

const AUTH_HEADER_PATTERN = /^(authorization|x-api-key|api-key|x-auth-token)$/i;
const AUTH_KEY_PATTERN = /(token|secret|password|api[_-]?key|authorization|bearer)/i;

export type McpAuthDiagnosticLevel = "none" | "possible" | "required";

export interface McpAuthDiagnostic {
  level: McpAuthDiagnosticLevel;
  message: string;
}

/**
 * HTTP auth diagnostics intentionally report only credential presence, never
 * credential values. This keeps MCP connection errors actionable while keeping
 * headers, env, and URL secrets inside the main-process configuration boundary.
 */
export function diagnoseMcpHttpAuthFailure(
  config: McpServerConfig,
  status: number,
): McpAuthDiagnostic {
  if (status !== 401 && status !== 403) {
    return {
      level: "none",
      message: `MCP HTTP request failed with status ${status}.`,
    };
  }
  const material = detectAuthMaterial(config);
  const statusLabel = status === 401 ? "401 Unauthorized" : "403 Forbidden";
  if (material.length === 0) {
    return {
      level: "required",
      message: `MCP HTTP request failed with status ${statusLabel}; authentication appears required and no auth material is configured.`,
    };
  }
  return {
    level: "possible",
    message: `MCP HTTP request failed with status ${statusLabel}; authentication failed even though auth material is configured in ${material.join(", ")}.`,
  };
}

function detectAuthMaterial(config: McpServerConfig): string[] {
  const locations = new Set<string>();
  for (const key of Object.keys(config.headers)) {
    if (AUTH_HEADER_PATTERN.test(key) || AUTH_KEY_PATTERN.test(key)) {
      locations.add("headers");
    }
  }
  for (const key of Object.keys(config.env)) {
    if (AUTH_KEY_PATTERN.test(key)) {
      locations.add("environment");
    }
  }
  if (config.url && hasUrlAuthMaterial(config.url)) {
    locations.add("URL");
  }
  return [...locations];
}

function hasUrlAuthMaterial(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password) {
      return true;
    }
    for (const key of url.searchParams.keys()) {
      if (AUTH_KEY_PATTERN.test(key)) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

import type { McpToolDescriptor } from "./protocol.js";
import { shouldUseProgressiveDiscoveryFacade } from "./mcp-facade.js";

export type McpRegisteredToolMode = "none" | "lazy" | "live" | "facade" | "lazy_facade";

export interface McpToolRegistrationPlan {
  mode: Exclude<McpRegisteredToolMode, "none">;
  useFacade: boolean;
  lazy: boolean;
}

export function planMcpToolRegistration(
  tools: readonly McpToolDescriptor[],
  options: { lazy?: boolean } = {},
): McpToolRegistrationPlan {
  const lazy = options.lazy === true;
  const useFacade = shouldUseProgressiveDiscoveryFacade(tools);
  if (useFacade) {
    return {
      mode: lazy ? "lazy_facade" : "facade",
      useFacade,
      lazy,
    };
  }
  return {
    mode: lazy ? "lazy" : "live",
    useFacade,
    lazy,
  };
}

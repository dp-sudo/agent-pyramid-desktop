import type { AgentDesktopApi } from "../../shared/agent-api";

declare global {
  interface Window {
    agentApi: AgentDesktopApi;
  }
}

export {};

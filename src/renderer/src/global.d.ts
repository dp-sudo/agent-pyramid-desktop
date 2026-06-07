import type { AgentDesktopApi } from "../../preload";

declare global {
  interface Window {
    agentApi: AgentDesktopApi;
  }
}

export {};

import { contextBridge, ipcRenderer } from "electron";
import type { AgentRunRequest, AgentRunResponse } from "../shared/agent-contracts";
import { AGENT_RUN_CHANNEL } from "../shared/ipc";

const agentApi = {
  run(request: AgentRunRequest): Promise<AgentRunResponse> {
    return ipcRenderer.invoke(AGENT_RUN_CHANNEL, request) as Promise<AgentRunResponse>;
  }
};

contextBridge.exposeInMainWorld("agentApi", agentApi);

export type AgentDesktopApi = typeof agentApi;

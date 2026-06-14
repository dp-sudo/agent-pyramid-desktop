import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { isRuntimeEvent } from "../shared/agent-contracts";
import type {
  AgentDesktopApi,
  AgentDesktopRuntimeEventListener,
} from "../shared/agent-api";
import type {
  AttachmentCreateRequest,
  AttachmentDeleteResponse,
  AttachmentRecord,
  ApprovalRespondRequest,
  CheckpointListRequest,
  CheckpointListResponse,
  CheckpointRewindRequest,
  CheckpointRewindResponse,
  GoalUpdateRequest,
  IpcResult,
  McpServerConnectRequest,
  McpServerDisconnectRequest,
  McpServerListResponse,
  McpPromptGetRequest,
  McpPromptResult,
  McpResourceReadRequest,
  McpResourceReadResult,
  McpServerPromptsRequest,
  McpServerPromptsResponse,
  McpServerResourcesRequest,
  McpServerResourcesResponse,
  McpServerRefreshToolsRequest,
  McpServerStatusRecord,
  McpServerToolsRequest,
  McpServerToolsResponse,
  RuntimePreferences,
  RuntimePreferencesUpdate,
  SkillListRequest,
  SkillListResponse,
  SseSubscribeGlobalResponse,
  SseSubscribeRequest,
  SseUnsubscribeGlobalResponse,
  SseUnsubscribeRequest,
  ThreadCreateInput,
  ThreadListFilter,
  ThreadRecord,
  ThreadSummary,
  ThreadUpdatePatch,
  TurnRecord,
  TurnStartRequest,
  WriteCompleteRequest,
  WriteCompleteResponse,
  WriteCreateRequest,
  WriteDeleteRequest,
  WriteFileEntry,
  WriteGetRequest,
  WriteListRequest,
  WritePutRequest,
  WriteRenameRequest,
  Item,
  UsageDailyBucket,
  UsageDailyRequest,
  WorkspacePickDirectoryResponse,
  ModelConfig,
  ModelConfigProfile,
  ModelConfigProfileActivateRequest,
  ModelConfigProfileCreateRequest,
  ModelConfigProfileDeleteRequest,
  ModelConfigProfilesState,
  ModelConfigProfileUpdateRequest,
  ModelConfigUpdate,
} from "../shared/agent-contracts";
import {
  ATTACHMENT_CREATE_CHANNEL,
  ATTACHMENT_DELETE_CHANNEL,
  ATTACHMENT_GET_CHANNEL,
  APPROVAL_RESPOND_CHANNEL,
  CHECKPOINT_LIST_CHANNEL,
  CHECKPOINT_REWIND_CHANNEL,
  GOAL_UPDATE_CHANNEL,
  SSE_PUSH_CHANNEL,
  SSE_SUBSCRIBE_CHANNEL,
  SSE_UNSUBSCRIBE_CHANNEL,
  THREAD_CREATE_CHANNEL,
  THREAD_DELETE_CHANNEL,
  THREAD_FORK_CHANNEL,
  THREAD_GET_CHANNEL,
  THREAD_LIST_CHANNEL,
  THREAD_UPDATE_CHANNEL,
  TURN_GET_CHANNEL,
  TURN_INTERRUPT_CHANNEL,
  TURN_START_CHANNEL,
  USAGE_DAILY_CHANNEL,
  WORKSPACE_PICK_DIRECTORY_CHANNEL,
  WRITE_COMPLETE_CHANNEL,
  WRITE_CREATE_CHANNEL,
  WRITE_DELETE_CHANNEL,
  WRITE_GET_CHANNEL,
  WRITE_LIST_CHANNEL,
  WRITE_PUT_CHANNEL,
  WRITE_RENAME_CHANNEL,
  MODEL_CONFIG_GET_CHANNEL,
  MODEL_CONFIG_PROFILES_ACTIVATE_CHANNEL,
  MODEL_CONFIG_PROFILES_CREATE_CHANNEL,
  MODEL_CONFIG_PROFILES_DELETE_CHANNEL,
  MODEL_CONFIG_PROFILES_LIST_CHANNEL,
  MODEL_CONFIG_PROFILES_UPDATE_CHANNEL,
  MODEL_CONFIG_UPDATE_CHANNEL,
  MCP_SERVERS_CONNECT_CHANNEL,
  MCP_SERVERS_DISCONNECT_CHANNEL,
  MCP_SERVERS_LIST_CHANNEL,
  MCP_SURFACE_REFRESH_CHANNEL,
  MCP_PROMPTS_GET_CHANNEL,
  MCP_PROMPTS_LIST_CHANNEL,
  MCP_RESOURCES_LIST_CHANNEL,
  MCP_RESOURCES_READ_CHANNEL,
  MCP_TOOLS_LIST_CHANNEL,
  MCP_TOOLS_REFRESH_CHANNEL,
  RUNTIME_PREFERENCES_GET_CHANNEL,
  RUNTIME_PREFERENCES_UPDATE_CHANNEL,
  SKILL_LIST_CHANNEL,
  SSE_SUBSCRIBE_GLOBAL_CHANNEL,
  SSE_UNSUBSCRIBE_GLOBAL_CHANNEL,
} from "../shared/ipc";

const threads = {
  list(filter: ThreadListFilter): Promise<IpcResult<ThreadSummary[]>> {
    return ipcRenderer.invoke(THREAD_LIST_CHANNEL, filter) as Promise<
      IpcResult<ThreadSummary[]>
    >;
  },
  create(input: ThreadCreateInput): Promise<IpcResult<ThreadRecord>> {
    return ipcRenderer.invoke(THREAD_CREATE_CHANNEL, input) as Promise<
      IpcResult<ThreadRecord>
    >;
  },
  get(id: string): Promise<IpcResult<ThreadRecord>> {
    return ipcRenderer.invoke(THREAD_GET_CHANNEL, id) as Promise<IpcResult<ThreadRecord>>;
  },
  update(id: string, patch: ThreadUpdatePatch): Promise<IpcResult<ThreadRecord>> {
    return ipcRenderer.invoke(THREAD_UPDATE_CHANNEL, id, patch) as Promise<
      IpcResult<ThreadRecord>
    >;
  },
  delete(id: string): Promise<IpcResult<{ id: string }>> {
    return ipcRenderer.invoke(THREAD_DELETE_CHANNEL, id) as Promise<
      IpcResult<{ id: string }>
    >;
  },
  fork(parentId: string): Promise<IpcResult<ThreadRecord>> {
    return ipcRenderer.invoke(THREAD_FORK_CHANNEL, parentId) as Promise<
      IpcResult<ThreadRecord>
    >;
  },
};

const turns = {
  start(request: TurnStartRequest): Promise<IpcResult<TurnRecord>> {
    return ipcRenderer.invoke(TURN_START_CHANNEL, request) as Promise<
      IpcResult<TurnRecord>
    >;
  },
  interrupt(turnId: string): Promise<IpcResult<{ turnId: string }>> {
    return ipcRenderer.invoke(TURN_INTERRUPT_CHANNEL, turnId) as Promise<
      IpcResult<{ turnId: string }>
    >;
  },
  get(threadId: string): Promise<IpcResult<{ threadId: string; items: Item[] }>> {
    return ipcRenderer.invoke(TURN_GET_CHANNEL, threadId) as Promise<
      IpcResult<{ threadId: string; items: Item[] }>
    >;
  },
};

const sseListeners = new Set<AgentDesktopRuntimeEventListener>();

ipcRenderer.on(SSE_PUSH_CHANNEL, (_event: IpcRendererEvent, payload: unknown) => {
  if (!isRuntimeEvent(payload)) {
    console.warn("[preload] dropped invalid runtime event payload.");
    return;
  }
  for (const listener of sseListeners) {
    listener(payload);
  }
});

const sse = {
  subscribe(request: SseSubscribeRequest): Promise<IpcResult<{ subscribed: string }>> {
    return ipcRenderer.invoke(SSE_SUBSCRIBE_CHANNEL, request) as Promise<
      IpcResult<{ subscribed: string }>
    >;
  },
  unsubscribe(
    request: SseUnsubscribeRequest,
  ): Promise<IpcResult<{ unsubscribed: boolean }>> {
    return ipcRenderer.invoke(SSE_UNSUBSCRIBE_CHANNEL, request) as Promise<
      IpcResult<{ unsubscribed: boolean }>
    >;
  },
  subscribeGlobal(): Promise<IpcResult<SseSubscribeGlobalResponse>> {
    return ipcRenderer.invoke(SSE_SUBSCRIBE_GLOBAL_CHANNEL) as Promise<
      IpcResult<SseSubscribeGlobalResponse>
    >;
  },
  unsubscribeGlobal(): Promise<IpcResult<SseUnsubscribeGlobalResponse>> {
    return ipcRenderer.invoke(SSE_UNSUBSCRIBE_GLOBAL_CHANNEL) as Promise<
      IpcResult<SseUnsubscribeGlobalResponse>
    >;
  },
  onEvent(listener: AgentDesktopRuntimeEventListener): () => void {
    sseListeners.add(listener);
    return () => {
      sseListeners.delete(listener);
    };
  },
};

const approvals = {
  respond(
    request: ApprovalRespondRequest,
  ): Promise<IpcResult<{ approvalId: string; decision: "allow" | "deny" }>> {
    return ipcRenderer.invoke(APPROVAL_RESPOND_CHANNEL, request) as Promise<
      IpcResult<{ approvalId: string; decision: "allow" | "deny" }>
    >;
  },
};

const goals = {
  update(request: GoalUpdateRequest): Promise<IpcResult<ThreadRecord>> {
    return ipcRenderer.invoke(GOAL_UPDATE_CHANNEL, request) as Promise<
      IpcResult<ThreadRecord>
    >;
  },
};

const attachments = {
  create(request: AttachmentCreateRequest): Promise<IpcResult<AttachmentRecord>> {
    return ipcRenderer.invoke(ATTACHMENT_CREATE_CHANNEL, request) as Promise<
      IpcResult<AttachmentRecord>
    >;
  },
  get(
    id: string,
  ): Promise<IpcResult<AttachmentRecord & { dataBase64: string }>> {
    return ipcRenderer.invoke(ATTACHMENT_GET_CHANNEL, id) as Promise<
      IpcResult<AttachmentRecord & { dataBase64: string }>
    >;
  },
  delete(id: string): Promise<IpcResult<AttachmentDeleteResponse>> {
    return ipcRenderer.invoke(ATTACHMENT_DELETE_CHANNEL, { id }) as Promise<
      IpcResult<AttachmentDeleteResponse>
    >;
  },
};

const usage = {
  daily(request?: UsageDailyRequest): Promise<IpcResult<UsageDailyBucket[]>> {
    return ipcRenderer.invoke(USAGE_DAILY_CHANNEL, request) as Promise<
      IpcResult<UsageDailyBucket[]>
    >;
  },
};

const checkpoints = {
  list(request: CheckpointListRequest): Promise<IpcResult<CheckpointListResponse>> {
    return ipcRenderer.invoke(CHECKPOINT_LIST_CHANNEL, request) as Promise<
      IpcResult<CheckpointListResponse>
    >;
  },
  rewind(
    request: CheckpointRewindRequest,
  ): Promise<IpcResult<CheckpointRewindResponse>> {
    return ipcRenderer.invoke(CHECKPOINT_REWIND_CHANNEL, request) as Promise<
      IpcResult<CheckpointRewindResponse>
    >;
  },
};

const mcp = {
  listServers(): Promise<IpcResult<McpServerListResponse>> {
    return ipcRenderer.invoke(MCP_SERVERS_LIST_CHANNEL) as Promise<
      IpcResult<McpServerListResponse>
    >;
  },
  connect(request: McpServerConnectRequest): Promise<IpcResult<McpServerStatusRecord>> {
    return ipcRenderer.invoke(MCP_SERVERS_CONNECT_CHANNEL, request) as Promise<
      IpcResult<McpServerStatusRecord>
    >;
  },
  disconnect(
    request: McpServerDisconnectRequest,
  ): Promise<IpcResult<McpServerStatusRecord>> {
    return ipcRenderer.invoke(MCP_SERVERS_DISCONNECT_CHANNEL, request) as Promise<
      IpcResult<McpServerStatusRecord>
    >;
  },
  listTools(request?: McpServerToolsRequest): Promise<IpcResult<McpServerToolsResponse>> {
    return ipcRenderer.invoke(MCP_TOOLS_LIST_CHANNEL, request) as Promise<
      IpcResult<McpServerToolsResponse>
    >;
  },
  refreshTools(
    request: McpServerRefreshToolsRequest,
  ): Promise<IpcResult<McpServerStatusRecord>> {
    return ipcRenderer.invoke(MCP_TOOLS_REFRESH_CHANNEL, request) as Promise<
      IpcResult<McpServerStatusRecord>
    >;
  },
  refreshSurface(
    request: McpServerRefreshToolsRequest,
  ): Promise<IpcResult<McpServerStatusRecord>> {
    return ipcRenderer.invoke(MCP_SURFACE_REFRESH_CHANNEL, request) as Promise<
      IpcResult<McpServerStatusRecord>
    >;
  },
  listPrompts(
    request?: McpServerPromptsRequest,
  ): Promise<IpcResult<McpServerPromptsResponse>> {
    return ipcRenderer.invoke(MCP_PROMPTS_LIST_CHANNEL, request) as Promise<
      IpcResult<McpServerPromptsResponse>
    >;
  },
  getPrompt(request: McpPromptGetRequest): Promise<IpcResult<McpPromptResult>> {
    return ipcRenderer.invoke(MCP_PROMPTS_GET_CHANNEL, request) as Promise<
      IpcResult<McpPromptResult>
    >;
  },
  listResources(
    request?: McpServerResourcesRequest,
  ): Promise<IpcResult<McpServerResourcesResponse>> {
    return ipcRenderer.invoke(MCP_RESOURCES_LIST_CHANNEL, request) as Promise<
      IpcResult<McpServerResourcesResponse>
    >;
  },
  readResource(request: McpResourceReadRequest): Promise<IpcResult<McpResourceReadResult>> {
    return ipcRenderer.invoke(MCP_RESOURCES_READ_CHANNEL, request) as Promise<
      IpcResult<McpResourceReadResult>
    >;
  },
};

const workspace = {
  pickDirectory(): Promise<IpcResult<WorkspacePickDirectoryResponse>> {
    return ipcRenderer.invoke(WORKSPACE_PICK_DIRECTORY_CHANNEL) as Promise<
      IpcResult<WorkspacePickDirectoryResponse>
    >;
  },
};

const write = {
  list(request: WriteListRequest): Promise<IpcResult<WriteFileEntry[]>> {
    return ipcRenderer.invoke(WRITE_LIST_CHANNEL, request) as Promise<
      IpcResult<WriteFileEntry[]>
    >;
  },
  get(
    request: WriteGetRequest,
  ): Promise<IpcResult<{ path: string; content: string }>> {
    return ipcRenderer.invoke(WRITE_GET_CHANNEL, request) as Promise<
      IpcResult<{ path: string; content: string }>
    >;
  },
  put(
    request: WritePutRequest,
  ): Promise<IpcResult<{ path: string; bytes: number }>> {
    return ipcRenderer.invoke(WRITE_PUT_CHANNEL, request) as Promise<
      IpcResult<{ path: string; bytes: number }>
    >;
  },
  create(
    request: WriteCreateRequest,
  ): Promise<IpcResult<{ path: string; content: string; bytes: number }>> {
    return ipcRenderer.invoke(WRITE_CREATE_CHANNEL, request) as Promise<
      IpcResult<{ path: string; content: string; bytes: number }>
    >;
  },
  rename(
    request: WriteRenameRequest,
  ): Promise<IpcResult<{ path: string; newPath: string }>> {
    return ipcRenderer.invoke(WRITE_RENAME_CHANNEL, request) as Promise<
      IpcResult<{ path: string; newPath: string }>
    >;
  },
  delete(
    request: WriteDeleteRequest,
  ): Promise<IpcResult<{ path: string }>> {
    return ipcRenderer.invoke(WRITE_DELETE_CHANNEL, request) as Promise<
      IpcResult<{ path: string }>
    >;
  },
  complete(
    request: WriteCompleteRequest,
  ): Promise<IpcResult<WriteCompleteResponse>> {
    return ipcRenderer.invoke(WRITE_COMPLETE_CHANNEL, request) as Promise<
      IpcResult<WriteCompleteResponse>
    >;
  },
};

const modelConfig = {
  get(): Promise<IpcResult<ModelConfig>> {
    return ipcRenderer.invoke(MODEL_CONFIG_GET_CHANNEL) as Promise<
      IpcResult<ModelConfig>
    >;
  },
  update(update: ModelConfigUpdate): Promise<IpcResult<ModelConfig>> {
    return ipcRenderer.invoke(MODEL_CONFIG_UPDATE_CHANNEL, update) as Promise<
      IpcResult<ModelConfig>
    >;
  },
  listProfiles(): Promise<IpcResult<ModelConfigProfilesState>> {
    return ipcRenderer.invoke(MODEL_CONFIG_PROFILES_LIST_CHANNEL) as Promise<
      IpcResult<ModelConfigProfilesState>
    >;
  },
  createProfile(
    request: ModelConfigProfileCreateRequest,
  ): Promise<IpcResult<ModelConfigProfilesState>> {
    return ipcRenderer.invoke(MODEL_CONFIG_PROFILES_CREATE_CHANNEL, request) as Promise<
      IpcResult<ModelConfigProfilesState>
    >;
  },
  updateProfile(
    request: ModelConfigProfileUpdateRequest,
  ): Promise<IpcResult<ModelConfigProfile>> {
    return ipcRenderer.invoke(MODEL_CONFIG_PROFILES_UPDATE_CHANNEL, request) as Promise<
      IpcResult<ModelConfigProfile>
    >;
  },
  deleteProfile(
    request: ModelConfigProfileDeleteRequest,
  ): Promise<IpcResult<ModelConfigProfilesState>> {
    return ipcRenderer.invoke(MODEL_CONFIG_PROFILES_DELETE_CHANNEL, request) as Promise<
      IpcResult<ModelConfigProfilesState>
    >;
  },
  activateProfile(
    request: ModelConfigProfileActivateRequest,
  ): Promise<IpcResult<ModelConfigProfilesState>> {
    return ipcRenderer.invoke(MODEL_CONFIG_PROFILES_ACTIVATE_CHANNEL, request) as Promise<
      IpcResult<ModelConfigProfilesState>
    >;
  },
};

const runtimePreferences = {
  get(): Promise<IpcResult<RuntimePreferences>> {
    return ipcRenderer.invoke(RUNTIME_PREFERENCES_GET_CHANNEL) as Promise<
      IpcResult<RuntimePreferences>
    >;
  },
  update(update: RuntimePreferencesUpdate): Promise<IpcResult<RuntimePreferences>> {
    return ipcRenderer.invoke(RUNTIME_PREFERENCES_UPDATE_CHANNEL, update) as Promise<
      IpcResult<RuntimePreferences>
    >;
  },
};

const skills = {
  list(request: SkillListRequest): Promise<IpcResult<SkillListResponse>> {
    return ipcRenderer.invoke(SKILL_LIST_CHANNEL, request) as Promise<
      IpcResult<SkillListResponse>
    >;
  },
};

export const agentApi = {
  threads,
  turns,
  sse,
  approvals,
  goals,
  attachments,
  usage,
  checkpoints,
  mcp,
  workspace,
  write,
  modelConfig,
  runtimePreferences,
  skills,
} satisfies AgentDesktopApi;

contextBridge.exposeInMainWorld("agentApi", agentApi);

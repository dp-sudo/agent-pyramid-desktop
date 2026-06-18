import type {
  AttachmentCreateRequest,
  AttachmentDeleteResponse,
  AttachmentRecord,
  ApprovalRespondRequest,
  ApprovalRespondResponse,
  CheckpointListRequest,
  CheckpointListResponse,
  CheckpointRewindRequest,
  CheckpointRewindResponse,
  GoalUpdateRequest,
  IpcResult,
  Item,
  McpPromptGetRequest,
  McpPromptResult,
  McpResourceReadRequest,
  McpResourceReadResult,
  McpServerConnectRequest,
  McpServerDisconnectRequest,
  McpServerListResponse,
  McpServerPromptsRequest,
  McpServerPromptsResponse,
  McpServerRefreshToolsRequest,
  McpServerResourcesRequest,
  McpServerResourcesResponse,
  McpServerStatusRecord,
  McpServerToolsRequest,
  McpServerToolsResponse,
  RuntimeEvent,
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
  UserInputRespondRequest,
  UserInputRespondResponse,
  UsageDailyBucket,
  UsageDailyRequest,
  WorkspacePickDirectoryResponse,
  WriteCompleteRequest,
  WriteCompleteResponse,
  WriteCreateRequest,
  WriteDeleteRequest,
  WriteFileEntry,
  WriteGetRequest,
  WriteListRequest,
  WritePutRequest,
  WriteRenameRequest,
} from "./agent-contracts.js";
import type {
  ModelConfigProfileActivateRequest,
  ModelConfigProfileCreateRequest,
  ModelConfigProfileDeleteRequest,
  ModelConfigProfileUpdateRequest,
  ModelConfigUpdate,
  RendererModelConfig,
  RendererModelConfigProfile,
  RendererModelConfigProfilesState,
} from "./model-config-contracts.js";

export type AgentDesktopRuntimeEventListener = (event: RuntimeEvent) => void;

/**
 * Shared renderer-visible preload surface. Keeping the type in shared lets the
 * renderer declare `window.agentApi` without importing `src/preload`, while
 * preload checks its exposed object against the same contract.
 */
export interface AgentDesktopApi {
  threads: {
    list(filter: ThreadListFilter): Promise<IpcResult<ThreadSummary[]>>;
    create(input: ThreadCreateInput): Promise<IpcResult<ThreadRecord>>;
    get(id: string): Promise<IpcResult<ThreadRecord>>;
    update(id: string, patch: ThreadUpdatePatch): Promise<IpcResult<ThreadRecord>>;
    delete(id: string): Promise<IpcResult<{ id: string }>>;
    fork(parentId: string): Promise<IpcResult<ThreadRecord>>;
  };
  turns: {
    start(request: TurnStartRequest): Promise<IpcResult<TurnRecord>>;
    interrupt(turnId: string): Promise<IpcResult<{ turnId: string }>>;
    get(threadId: string): Promise<IpcResult<{ threadId: string; items: Item[] }>>;
  };
  sse: {
    subscribe(request: SseSubscribeRequest): Promise<IpcResult<{ subscribed: string }>>;
    unsubscribe(request: SseUnsubscribeRequest): Promise<IpcResult<{ unsubscribed: boolean }>>;
    subscribeGlobal(): Promise<IpcResult<SseSubscribeGlobalResponse>>;
    unsubscribeGlobal(): Promise<IpcResult<SseUnsubscribeGlobalResponse>>;
    onEvent(listener: AgentDesktopRuntimeEventListener): () => void;
  };
  approvals: {
    respond(
      request: ApprovalRespondRequest,
    ): Promise<IpcResult<ApprovalRespondResponse>>;
  };
  userInput: {
    respond(
      request: UserInputRespondRequest,
    ): Promise<IpcResult<UserInputRespondResponse>>;
  };
  goals: {
    update(request: GoalUpdateRequest): Promise<IpcResult<ThreadRecord>>;
  };
  attachments: {
    create(request: AttachmentCreateRequest): Promise<IpcResult<AttachmentRecord>>;
    get(id: string): Promise<IpcResult<AttachmentRecord & { dataBase64: string }>>;
    delete(id: string): Promise<IpcResult<AttachmentDeleteResponse>>;
  };
  usage: {
    daily(request?: UsageDailyRequest): Promise<IpcResult<UsageDailyBucket[]>>;
  };
  checkpoints: {
    list(request: CheckpointListRequest): Promise<IpcResult<CheckpointListResponse>>;
    rewind(request: CheckpointRewindRequest): Promise<IpcResult<CheckpointRewindResponse>>;
  };
  mcp: {
    listServers(): Promise<IpcResult<McpServerListResponse>>;
    connect(request: McpServerConnectRequest): Promise<IpcResult<McpServerStatusRecord>>;
    disconnect(request: McpServerDisconnectRequest): Promise<IpcResult<McpServerStatusRecord>>;
    listTools(request?: McpServerToolsRequest): Promise<IpcResult<McpServerToolsResponse>>;
    refreshTools(request: McpServerRefreshToolsRequest): Promise<IpcResult<McpServerStatusRecord>>;
    refreshSurface(
      request: McpServerRefreshToolsRequest,
    ): Promise<IpcResult<McpServerStatusRecord>>;
    listPrompts(
      request?: McpServerPromptsRequest,
    ): Promise<IpcResult<McpServerPromptsResponse>>;
    getPrompt(request: McpPromptGetRequest): Promise<IpcResult<McpPromptResult>>;
    listResources(
      request?: McpServerResourcesRequest,
    ): Promise<IpcResult<McpServerResourcesResponse>>;
    readResource(request: McpResourceReadRequest): Promise<IpcResult<McpResourceReadResult>>;
  };
  workspace: {
    pickDirectory(): Promise<IpcResult<WorkspacePickDirectoryResponse>>;
  };
  write: {
    list(request: WriteListRequest): Promise<IpcResult<WriteFileEntry[]>>;
    get(request: WriteGetRequest): Promise<IpcResult<{ path: string; content: string }>>;
    put(request: WritePutRequest): Promise<IpcResult<{ path: string; bytes: number }>>;
    create(
      request: WriteCreateRequest,
    ): Promise<IpcResult<{ path: string; content: string; bytes: number }>>;
    rename(request: WriteRenameRequest): Promise<IpcResult<{ path: string; newPath: string }>>;
    delete(request: WriteDeleteRequest): Promise<IpcResult<{ path: string }>>;
    complete(request: WriteCompleteRequest): Promise<IpcResult<WriteCompleteResponse>>;
  };
  modelConfig: {
    get(): Promise<IpcResult<RendererModelConfig>>;
    update(update: ModelConfigUpdate): Promise<IpcResult<RendererModelConfig>>;
    listProfiles(): Promise<IpcResult<RendererModelConfigProfilesState>>;
    createProfile(
      request: ModelConfigProfileCreateRequest,
    ): Promise<IpcResult<RendererModelConfigProfilesState>>;
    updateProfile(
      request: ModelConfigProfileUpdateRequest,
    ): Promise<IpcResult<RendererModelConfigProfile>>;
    deleteProfile(
      request: ModelConfigProfileDeleteRequest,
    ): Promise<IpcResult<RendererModelConfigProfilesState>>;
    activateProfile(
      request: ModelConfigProfileActivateRequest,
    ): Promise<IpcResult<RendererModelConfigProfilesState>>;
  };
  runtimePreferences: {
    get(): Promise<IpcResult<RuntimePreferences>>;
    update(update: RuntimePreferencesUpdate): Promise<IpcResult<RuntimePreferences>>;
  };
  skills: {
    list(request: SkillListRequest): Promise<IpcResult<SkillListResponse>>;
  };
}

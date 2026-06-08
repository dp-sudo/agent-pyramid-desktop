import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  AttachmentCreateRequest,
  AttachmentDeleteResponse,
  AttachmentRecord,
  ApprovalRespondRequest,
  GoalUpdateRequest,
  IpcResult,
  RuntimeEvent,
  SseSubscribeRequest,
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
  WriteFileEntry,
  WriteGetRequest,
  WriteListRequest,
  WritePutRequest,
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
  WRITE_GET_CHANNEL,
  WRITE_LIST_CHANNEL,
  WRITE_PUT_CHANNEL,
  MODEL_CONFIG_GET_CHANNEL,
  MODEL_CONFIG_PROFILES_ACTIVATE_CHANNEL,
  MODEL_CONFIG_PROFILES_CREATE_CHANNEL,
  MODEL_CONFIG_PROFILES_DELETE_CHANNEL,
  MODEL_CONFIG_PROFILES_LIST_CHANNEL,
  MODEL_CONFIG_PROFILES_UPDATE_CHANNEL,
  MODEL_CONFIG_UPDATE_CHANNEL,
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

type SseListener = (event: RuntimeEvent) => void;
const sseListeners = new Set<SseListener>();

ipcRenderer.on(SSE_PUSH_CHANNEL, (_event: IpcRendererEvent, payload: RuntimeEvent) => {
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
  onEvent(listener: SseListener): () => void {
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

export const agentApi = {
  threads,
  turns,
  sse,
  approvals,
  goals,
  attachments,
  usage,
  workspace,
  write,
  modelConfig,
};

contextBridge.exposeInMainWorld("agentApi", agentApi);

export type AgentDesktopApi = typeof agentApi;

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  AgentRunRequest,
  AgentRunResponse,
  ApprovalRespondRequest,
  IpcResult,
  RuntimeEvent,
  SseSubscribeRequest,
  SseUnsubscribeRequest,
  ThreadCreateInput,
  ThreadListFilter,
  ThreadRecord,
  ThreadSummary,
  ThreadUpdatePatch,
  TurnInterruptOptions,
  TurnRecord,
  TurnStartRequest,
  WriteCompleteRequest,
  WriteCompleteResponse,
  WriteFileEntry,
  WriteGetRequest,
  WriteListRequest,
  WritePutRequest,
  Item,
} from "../shared/agent-contracts";
import {
  AGENT_RUN_CHANNEL,
  APPROVAL_RESPOND_CHANNEL,
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
  WRITE_COMPLETE_CHANNEL,
  WRITE_GET_CHANNEL,
  WRITE_LIST_CHANNEL,
  WRITE_PUT_CHANNEL,
} from "../shared/ipc";

const legacy = {
  run(request: AgentRunRequest): Promise<IpcResult<AgentRunResponse>> {
    return ipcRenderer.invoke(AGENT_RUN_CHANNEL, request) as Promise<
      IpcResult<AgentRunResponse>
    >;
  },
};

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
  interrupt(
    turnId: string,
    options?: TurnInterruptOptions,
  ): Promise<IpcResult<{ turnId: string }>> {
    return ipcRenderer.invoke(TURN_INTERRUPT_CHANNEL, turnId, options) as Promise<
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

export const agentApi = {
  ...legacy,
  threads,
  turns,
  sse,
  approvals,
  write,
};

contextBridge.exposeInMainWorld("agentApi", agentApi);

export type AgentDesktopApi = typeof agentApi;

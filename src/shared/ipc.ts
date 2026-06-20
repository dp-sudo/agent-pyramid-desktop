// Thread management
export const THREAD_LIST_CHANNEL = "thread:list";
export const THREAD_CREATE_CHANNEL = "thread:create";
export const THREAD_GET_CHANNEL = "thread:get";
export const THREAD_UPDATE_CHANNEL = "thread:update";
export const THREAD_DELETE_CHANNEL = "thread:delete";
export const THREAD_FORK_CHANNEL = "thread:fork";

// Turn lifecycle
export const TURN_START_CHANNEL = "turn:start";
export const TURN_INTERRUPT_CHANNEL = "turn:interrupt";
export const TURN_GET_CHANNEL = "turn:get";

// Streaming subscription
export const SSE_SUBSCRIBE_CHANNEL = "sse:subscribe";
export const SSE_UNSUBSCRIBE_CHANNEL = "sse:unsubscribe";
export const SSE_SUBSCRIBE_GLOBAL_CHANNEL = "sse:subscribe-global";
export const SSE_UNSUBSCRIBE_GLOBAL_CHANNEL = "sse:unsubscribe-global";
/** Main process pushes RuntimeEvent to renderer via this single channel. */
export const SSE_PUSH_CHANNEL = "sse:push";

// Approvals
export const APPROVAL_RESPOND_CHANNEL = "approval:respond";

// User input
export const USER_INPUT_RESPOND_CHANNEL = "user-input:respond";

// Goals
export const GOAL_UPDATE_CHANNEL = "goal:update";

// Attachments
export const ATTACHMENT_CREATE_CHANNEL = "attachment:create";
export const ATTACHMENT_GET_CHANNEL = "attachment:get";
export const ATTACHMENT_DELETE_CHANNEL = "attachment:delete";

// Usage
export const USAGE_DAILY_CHANNEL = "usage:daily";

// Checkpoints / rewind
export const CHECKPOINT_LIST_CHANNEL = "checkpoint:list";
export const CHECKPOINT_REWIND_CHANNEL = "checkpoint:rewind";

// Workspace services
export const WORKSPACE_PICK_DIRECTORY_CHANNEL = "workspace:pick-directory";

// Write-mode file services
export const WRITE_LIST_CHANNEL = "write:list";
export const WRITE_GET_CHANNEL = "write:get";
export const WRITE_PUT_CHANNEL = "write:put";
export const WRITE_COMPLETE_CHANNEL = "write:complete";
export const WRITE_CREATE_CHANNEL = "write:create";
export const WRITE_RENAME_CHANNEL = "write:rename";
export const WRITE_DELETE_CHANNEL = "write:delete";

// Model configuration
export const MODEL_CONFIG_GET_CHANNEL = "config:model:get";
export const MODEL_CONFIG_UPDATE_CHANNEL = "config:model:update";
export const MODEL_CONFIG_PROFILES_LIST_CHANNEL = "config:model:profiles:list";
export const MODEL_CONFIG_PROFILES_CREATE_CHANNEL = "config:model:profiles:create";
export const MODEL_CONFIG_PROFILES_UPDATE_CHANNEL = "config:model:profiles:update";
export const MODEL_CONFIG_PROFILES_DELETE_CHANNEL = "config:model:profiles:delete";
export const MODEL_CONFIG_PROFILES_ACTIVATE_CHANNEL = "config:model:profiles:activate";

// Runtime preferences
export const RUNTIME_PREFERENCES_GET_CHANNEL = "runtime-preferences:get";
export const RUNTIME_PREFERENCES_UPDATE_CHANNEL = "runtime-preferences:update";

// Skills catalog / diagnostics
export const SKILL_LIST_CHANNEL = "skills:list";

// MCP external tool host
export const MCP_SERVERS_LIST_CHANNEL = "mcp:servers:list";
export const MCP_SERVERS_CONNECT_CHANNEL = "mcp:servers:connect";
export const MCP_SERVERS_DISCONNECT_CHANNEL = "mcp:servers:disconnect";
export const MCP_TOOLS_LIST_CHANNEL = "mcp:tools:list";
export const MCP_TOOLS_REFRESH_CHANNEL = "mcp:tools:refresh";
export const MCP_SURFACE_REFRESH_CHANNEL = "mcp:surface:refresh";
export const MCP_PROMPTS_LIST_CHANNEL = "mcp:prompts:list";
export const MCP_PROMPTS_GET_CHANNEL = "mcp:prompts:get";
export const MCP_RESOURCES_LIST_CHANNEL = "mcp:resources:list";
export const MCP_RESOURCES_READ_CHANNEL = "mcp:resources:read";

export type IpcChannelGroup =
  | "threads"
  | "turns"
  | "sse"
  | "approvals"
  | "userInput"
  | "goals"
  | "attachments"
  | "usage"
  | "checkpoints"
  | "workspace"
  | "write"
  | "modelConfig"
  | "runtimePreferences"
  | "skills"
  | "mcp";

export interface RendererToMainChannelDescriptor {
  channel: string;
  group: IpcChannelGroup;
  method: string;
}

/**
 * Descriptor authority for renderer-invoked IPC. Channel constants stay exported
 * for handler/preload ergonomics, but the invoke allowlist is derived here so a
 * new channel has one shared place to declare its renderer surface.
 */
export const RENDERER_TO_MAIN_CHANNEL_DESCRIPTORS = [
  { channel: THREAD_LIST_CHANNEL, group: "threads", method: "list" },
  { channel: THREAD_CREATE_CHANNEL, group: "threads", method: "create" },
  { channel: THREAD_GET_CHANNEL, group: "threads", method: "get" },
  { channel: THREAD_UPDATE_CHANNEL, group: "threads", method: "update" },
  { channel: THREAD_DELETE_CHANNEL, group: "threads", method: "delete" },
  { channel: THREAD_FORK_CHANNEL, group: "threads", method: "fork" },
  { channel: TURN_START_CHANNEL, group: "turns", method: "start" },
  { channel: TURN_INTERRUPT_CHANNEL, group: "turns", method: "interrupt" },
  { channel: TURN_GET_CHANNEL, group: "turns", method: "get" },
  { channel: SSE_SUBSCRIBE_CHANNEL, group: "sse", method: "subscribe" },
  { channel: SSE_UNSUBSCRIBE_CHANNEL, group: "sse", method: "unsubscribe" },
  { channel: SSE_SUBSCRIBE_GLOBAL_CHANNEL, group: "sse", method: "subscribeGlobal" },
  { channel: SSE_UNSUBSCRIBE_GLOBAL_CHANNEL, group: "sse", method: "unsubscribeGlobal" },
  { channel: APPROVAL_RESPOND_CHANNEL, group: "approvals", method: "respond" },
  { channel: USER_INPUT_RESPOND_CHANNEL, group: "userInput", method: "respond" },
  { channel: GOAL_UPDATE_CHANNEL, group: "goals", method: "update" },
  { channel: ATTACHMENT_CREATE_CHANNEL, group: "attachments", method: "create" },
  { channel: ATTACHMENT_GET_CHANNEL, group: "attachments", method: "get" },
  { channel: ATTACHMENT_DELETE_CHANNEL, group: "attachments", method: "delete" },
  { channel: USAGE_DAILY_CHANNEL, group: "usage", method: "daily" },
  { channel: CHECKPOINT_LIST_CHANNEL, group: "checkpoints", method: "list" },
  { channel: CHECKPOINT_REWIND_CHANNEL, group: "checkpoints", method: "rewind" },
  { channel: WORKSPACE_PICK_DIRECTORY_CHANNEL, group: "workspace", method: "pickDirectory" },
  { channel: WRITE_LIST_CHANNEL, group: "write", method: "list" },
  { channel: WRITE_GET_CHANNEL, group: "write", method: "get" },
  { channel: WRITE_PUT_CHANNEL, group: "write", method: "put" },
  { channel: WRITE_COMPLETE_CHANNEL, group: "write", method: "complete" },
  { channel: WRITE_CREATE_CHANNEL, group: "write", method: "create" },
  { channel: WRITE_RENAME_CHANNEL, group: "write", method: "rename" },
  { channel: WRITE_DELETE_CHANNEL, group: "write", method: "delete" },
  { channel: MODEL_CONFIG_GET_CHANNEL, group: "modelConfig", method: "get" },
  { channel: MODEL_CONFIG_UPDATE_CHANNEL, group: "modelConfig", method: "update" },
  { channel: MODEL_CONFIG_PROFILES_LIST_CHANNEL, group: "modelConfig", method: "listProfiles" },
  { channel: MODEL_CONFIG_PROFILES_CREATE_CHANNEL, group: "modelConfig", method: "createProfile" },
  { channel: MODEL_CONFIG_PROFILES_UPDATE_CHANNEL, group: "modelConfig", method: "updateProfile" },
  { channel: MODEL_CONFIG_PROFILES_DELETE_CHANNEL, group: "modelConfig", method: "deleteProfile" },
  { channel: MODEL_CONFIG_PROFILES_ACTIVATE_CHANNEL, group: "modelConfig", method: "activateProfile" },
  { channel: RUNTIME_PREFERENCES_GET_CHANNEL, group: "runtimePreferences", method: "get" },
  { channel: RUNTIME_PREFERENCES_UPDATE_CHANNEL, group: "runtimePreferences", method: "update" },
  { channel: SKILL_LIST_CHANNEL, group: "skills", method: "list" },
  { channel: MCP_SERVERS_LIST_CHANNEL, group: "mcp", method: "listServers" },
  { channel: MCP_SERVERS_CONNECT_CHANNEL, group: "mcp", method: "connect" },
  { channel: MCP_SERVERS_DISCONNECT_CHANNEL, group: "mcp", method: "disconnect" },
  { channel: MCP_TOOLS_LIST_CHANNEL, group: "mcp", method: "listTools" },
  { channel: MCP_TOOLS_REFRESH_CHANNEL, group: "mcp", method: "refreshTools" },
  { channel: MCP_SURFACE_REFRESH_CHANNEL, group: "mcp", method: "refreshSurface" },
  { channel: MCP_PROMPTS_LIST_CHANNEL, group: "mcp", method: "listPrompts" },
  { channel: MCP_PROMPTS_GET_CHANNEL, group: "mcp", method: "getPrompt" },
  { channel: MCP_RESOURCES_LIST_CHANNEL, group: "mcp", method: "listResources" },
  { channel: MCP_RESOURCES_READ_CHANNEL, group: "mcp", method: "readResource" },
] as const satisfies readonly RendererToMainChannelDescriptor[];

/** All channels a renderer may invoke on the main process. */
export const RENDERER_TO_MAIN_CHANNELS = RENDERER_TO_MAIN_CHANNEL_DESCRIPTORS.map(
  (descriptor) => descriptor.channel,
);

export type RendererToMainChannel = (typeof RENDERER_TO_MAIN_CHANNELS)[number];

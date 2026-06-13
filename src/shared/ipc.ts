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
/** Main process pushes RuntimeEvent to renderer via this single channel. */
export const SSE_PUSH_CHANNEL = "sse:push";

// Approvals
export const APPROVAL_RESPOND_CHANNEL = "approval:respond";

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

/** All channels a renderer may invoke on the main process. */
export const RENDERER_TO_MAIN_CHANNELS = [
  THREAD_LIST_CHANNEL,
  THREAD_CREATE_CHANNEL,
  THREAD_GET_CHANNEL,
  THREAD_UPDATE_CHANNEL,
  THREAD_DELETE_CHANNEL,
  THREAD_FORK_CHANNEL,
  TURN_START_CHANNEL,
  TURN_INTERRUPT_CHANNEL,
  TURN_GET_CHANNEL,
  SSE_SUBSCRIBE_CHANNEL,
  SSE_UNSUBSCRIBE_CHANNEL,
  APPROVAL_RESPOND_CHANNEL,
  GOAL_UPDATE_CHANNEL,
  ATTACHMENT_CREATE_CHANNEL,
  ATTACHMENT_GET_CHANNEL,
  ATTACHMENT_DELETE_CHANNEL,
  USAGE_DAILY_CHANNEL,
  CHECKPOINT_LIST_CHANNEL,
  CHECKPOINT_REWIND_CHANNEL,
  WORKSPACE_PICK_DIRECTORY_CHANNEL,
  WRITE_LIST_CHANNEL,
  WRITE_GET_CHANNEL,
  WRITE_PUT_CHANNEL,
  WRITE_COMPLETE_CHANNEL,
  WRITE_CREATE_CHANNEL,
  WRITE_RENAME_CHANNEL,
  WRITE_DELETE_CHANNEL,
  MODEL_CONFIG_GET_CHANNEL,
  MODEL_CONFIG_UPDATE_CHANNEL,
  MODEL_CONFIG_PROFILES_LIST_CHANNEL,
  MODEL_CONFIG_PROFILES_CREATE_CHANNEL,
  MODEL_CONFIG_PROFILES_UPDATE_CHANNEL,
  MODEL_CONFIG_PROFILES_DELETE_CHANNEL,
  MODEL_CONFIG_PROFILES_ACTIVATE_CHANNEL,
  RUNTIME_PREFERENCES_GET_CHANNEL,
  RUNTIME_PREFERENCES_UPDATE_CHANNEL,
  MCP_SERVERS_LIST_CHANNEL,
  MCP_SERVERS_CONNECT_CHANNEL,
  MCP_SERVERS_DISCONNECT_CHANNEL,
  MCP_TOOLS_LIST_CHANNEL,
  MCP_TOOLS_REFRESH_CHANNEL,
  MCP_SURFACE_REFRESH_CHANNEL,
  MCP_PROMPTS_LIST_CHANNEL,
  MCP_PROMPTS_GET_CHANNEL,
  MCP_RESOURCES_LIST_CHANNEL,
  MCP_RESOURCES_READ_CHANNEL,
] as const;

export type RendererToMainChannel = (typeof RENDERER_TO_MAIN_CHANNELS)[number];

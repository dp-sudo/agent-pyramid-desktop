import type { ModelConfig } from "../../shared/agent-contracts.js";

// Main-process runtime/tool policy constants live here when they do not need to
// cross the preload/renderer boundary. Keeping shared tool limits in one file
// prevents equivalent tools from drifting to different thresholds.
export const DEFAULT_AGENT_AUTONOMY = "balanced";
export const AGENT_AUTONOMY_TOOL_ROUNDS = {
  conservative: 12,
  balanced: 32,
  deep: 64,
} as const satisfies Record<ModelConfig["agent_autonomy"], number>;
export const MIN_MAX_TOOL_ROUNDS = 1;
export const MAX_MAX_TOOL_ROUNDS = 128;
export const TOOL_ROUND_WARNING_THRESHOLD = 0.75;
export const TOOL_BUDGET_CONTINUATION_MESSAGE =
  "Automatic tool budget reached. Continue the thread to let the assistant use the gathered context, or raise AGENT_MAX_TOOL_ROUNDS for longer autonomous runs.";
export const CONTEXT_BUDGET_SAFETY_RATIO = 0.95;
export const TOOL_RESULT_MAX_LINES = 320;
export const TOOL_RESULT_MAX_BYTES = 32 * 1024;
export const TIGHT_TOOL_RESULT_MAX_LINES = 120;
export const TIGHT_TOOL_RESULT_MAX_BYTES = 8 * 1024;
export const TOOL_ARGUMENT_STRING_MAX_BYTES = 8 * 1024;
export const TIGHT_TOOL_ARGUMENT_STRING_MAX_BYTES = 2 * 1024;
export const TOOL_ARGUMENT_ARRAY_MAX_ITEMS = 80;
export const TIGHT_TOOL_ARGUMENT_ARRAY_MAX_ITEMS = 24;
export const TIGHT_SYSTEM_MESSAGE_MAX_BYTES = 4 * 1024;
export const TIGHT_ASSISTANT_MESSAGE_MAX_BYTES = 8 * 1024;
export const TIGHT_USER_MESSAGE_MAX_BYTES = 16 * 1024;
export const MIN_PROGRESSIVE_COMPACTION_BYTES = 128;
export const TOKEN_ESTIMATE_BYTES_PER_TOKEN = 4;
export const MIN_TEXT_COMPACTION_BYTES = 512;
export const MAX_PROGRESSIVE_COMPACTION_PASSES = 24;
export const ACTIVE_TOOL_INTERRUPT_SETTLE_TIMEOUT_MS = 3_000;

export const MAX_SEARCH_FILE_BYTES = 1_000_000;

export const DEFAULT_USAGE_DAYS = 30;
export const MAX_USAGE_DAYS = 180;
export const USAGE_CACHE_TTL_MS = 10_000;

export const MAX_COMMAND_BYTES = 4_096;
export const COMMAND_KILL_GRACE_MS = 1_000;
export const MAX_REGEX_PATTERN_BYTES = 4_096;
export const MAX_GIT_LOG_COUNT = 100;
export const DEFAULT_GIT_LOG_COUNT = 20;
export const MAX_COMMAND_SESSION_COUNT = 8;
export const MAX_COMMAND_SESSION_BUFFER_BYTES = 256 * 1024;
export const DEFAULT_COMMAND_SESSION_BUFFER_BYTES = 64 * 1024;
export const DEFAULT_COMMAND_SESSION_TAIL_BYTES = 32 * 1024;
export const COMMAND_SESSION_SPAWN_TIMEOUT_MS = 5_000;
export const COMMAND_SESSION_STOP_TIMEOUT_EXTRA_MS = 4_000;
export const MAX_PACKAGE_SCRIPT_NAME_BYTES = 128;

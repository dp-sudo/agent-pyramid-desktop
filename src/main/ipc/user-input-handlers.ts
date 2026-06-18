import { ipcMain } from "electron";
import { USER_INPUT_RESPOND_CHANNEL } from "../../shared/ipc.js";
import { IPC_ERROR_CODES } from "../../shared/ipc-errors.js";
import type {
  UserInputRespondRequest,
  UserInputRespondResponse,
} from "../../shared/agent-contracts.js";
import { err, ok } from "../../shared/agent-contracts.js";
import type { AgentRuntime } from "../application/agent-runtime.js";
import { messageOfIpcError as messageOf } from "./ipc-result-handler.js";

export function registerUserInputHandlers(runtime: AgentRuntime): void {
  ipcMain.handle(USER_INPUT_RESPOND_CHANNEL, async (_event, request: unknown) => {
    try {
      const parsed = parseUserInputRespondRequest(request);
      const response: UserInputRespondResponse = runtime.respondUserInput(parsed);
      return ok(response);
    } catch (error) {
      return err(IPC_ERROR_CODES.USER_INPUT_RESPOND_FAILED, messageOf(error));
    }
  });
}

// User-input responses resume a suspended turn. Validate the renderer payload
// before it can affect pending runtime state.
export function parseUserInputRespondRequest(request: unknown): UserInputRespondRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("User input response request must be an object.");
  }
  const value = request as Record<string, unknown>;
  if (typeof value.userInputId !== "string" || !value.userInputId.trim()) {
    throw new Error("User input response requires userInputId.");
  }
  if (value.cancelled !== undefined && typeof value.cancelled !== "boolean") {
    throw new Error("User input cancelled flag must be a boolean.");
  }
  if (value.answer !== undefined && typeof value.answer !== "string") {
    throw new Error("User input answer must be a string.");
  }
  if (value.cancelled === true) {
    return {
      userInputId: value.userInputId.trim(),
      cancelled: true,
    };
  }
  const answer = value.answer;
  if (typeof answer !== "string" || !answer.trim()) {
    throw new Error("User input response requires a non-empty answer or cancelled=true.");
  }
  return {
    userInputId: value.userInputId.trim(),
    answer: answer.trim(),
  };
}

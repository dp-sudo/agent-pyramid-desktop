import type { AgentTool } from "../../domain/agent/types.js";

const MAX_USER_INPUT_OPTIONS = 8;

export function createUserInputTools(): AgentTool[] {
  return [requestUserInputTool];
}

const requestUserInputTool: AgentTool = {
  definition: {
    name: "request_user_input",
    description:
      "Ask the user a concise clarification question and wait for their answer before continuing. Use this when required task information is missing and guessing would be unsafe.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          minLength: 1,
          description: "The single question to ask the user.",
        },
        options: {
          type: "array",
          items: { type: "string", minLength: 1 },
          maxItems: MAX_USER_INPUT_OPTIONS,
          description: "Optional short answer choices. Omit for free-form input.",
        },
      },
      required: ["question"],
    },
  },
  metadata: { isReadOnly: true, category: "interaction" },
  async execute(input, context) {
    // This read-only tool is a runtime interaction gate: execution pauses until
    // the renderer answers through UserInputCoordinator, then the answer returns
    // to the model as the next tool result.
    if (!context.requestUserInput) {
      throw new Error("request_user_input requires runtime user input capability.");
    }
    const resolution = await context.requestUserInput({
      question: requiredUserInputString(input.question, "request_user_input requires a question."),
      ...(input.options !== undefined ? { options: parseUserInputOptions(input.options) } : {}),
    });
    if (resolution.cancelled) {
      return JSON.stringify({
        status: "cancelled",
        message: "The user cancelled the input request.",
      });
    }
    return JSON.stringify({
      status: "answered",
      answer: resolution.answer,
    });
  },
};

function parseUserInputOptions(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("request_user_input options must be an array.");
  }
  if (value.length > MAX_USER_INPUT_OPTIONS) {
    throw new Error(`request_user_input options cannot exceed ${MAX_USER_INPUT_OPTIONS} entries.`);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const option = requiredUserInputString(
      entry,
      `request_user_input option ${index + 1} must be a non-empty string.`,
    );
    if (seen.has(option)) {
      throw new Error(`request_user_input option is duplicated: ${option}`);
    }
    seen.add(option);
    return option;
  });
}

function requiredUserInputString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(message);
  }
  if (value.includes("\0")) {
    throw new Error("request_user_input strings cannot contain NUL bytes.");
  }
  return value.trim();
}

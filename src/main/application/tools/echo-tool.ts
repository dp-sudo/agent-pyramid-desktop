import type { AgentTool } from "../../domain/agent/types";

export const echoTool: AgentTool = {
  definition: {
    name: "echo",
    description: "Return the provided text unchanged. Useful for verifying tool-call plumbing.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Text to return."
        }
      },
      required: ["text"]
    }
  },
  async execute(input) {
    const text = input.text;

    if (typeof text !== "string") {
      throw new Error("echo tool requires a string field named text.");
    }

    return text;
  }
};

import { describe, expect, it } from "vitest";
import {
  canExecuteToolCallsInParallel,
  isParallelSafeReadOnlyToolCall,
} from "../../../src/main/application/runtime-tool-rounds";
import type { ToolRegistry } from "../../../src/main/domain/agent/ports";

describe("runtime tool rounds", () => {
  it("allows only multi-call read-only batches to run in parallel", () => {
    const registry = registryWith({
      read_file: true,
      search_files: true,
      write_file: false,
      run_skill: true,
      request_user_input: true,
    });

    expect(canExecuteToolCallsInParallel(registry, [
      call("read_file"),
      call("search_files"),
    ])).toBe(true);
    expect(canExecuteToolCallsInParallel(registry, [call("read_file")])).toBe(false);
    expect(canExecuteToolCallsInParallel(registry, [
      call("read_file"),
      call("write_file"),
    ])).toBe(false);
    expect(isParallelSafeReadOnlyToolCall(registry, call("run_skill"))).toBe(false);
    expect(isParallelSafeReadOnlyToolCall(registry, call("request_user_input"))).toBe(false);
  });
});

function registryWith(readOnlyByName: Record<string, boolean>): Pick<ToolRegistry, "getTool"> {
  return {
    getTool(name) {
      const readOnly = readOnlyByName[name];
      if (readOnly === undefined) return undefined;
      return {
        definition: {
          name,
          description: name,
          inputSchema: { type: "object" },
        },
        metadata: { isReadOnly: readOnly },
        async execute() {
          return "";
        },
      };
    },
  };
}

function call(name: string) {
  return {
    id: `call-${name}`,
    name,
    arguments: {},
  };
}

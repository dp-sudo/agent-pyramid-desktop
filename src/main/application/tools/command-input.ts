import {
  MAX_COMMAND_BYTES,
  MAX_REGEX_PATTERN_BYTES,
} from "../constants.js";

export function requiredCommand(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("run_command requires a non-empty command string.");
  }
  if (value.includes("\0")) {
    throw new Error("run_command command cannot contain NUL bytes.");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_COMMAND_BYTES) {
    throw new Error(`run_command command exceeds ${MAX_COMMAND_BYTES} bytes.`);
  }
  return value.trim();
}

export function requiredCommandForTool(value: unknown, toolName: string): string {
  return requiredLimitedString(
    value,
    `${toolName} requires a non-empty command string.`,
    MAX_COMMAND_BYTES,
  );
}

export function requiredLimitedString(
  value: unknown,
  message: string,
  maxBytes: number,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(message);
  }
  if (value.includes("\0")) {
    throw new Error("string value cannot contain NUL bytes.");
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`string value exceeds ${maxBytes} bytes.`);
  }
  return value.trim();
}

export function requiredSessionInput(value: unknown, message: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(message);
  }
  if (value.includes("\0")) {
    throw new Error("string value cannot contain NUL bytes.");
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`string value exceeds ${maxBytes} bytes.`);
  }
  return value;
}

export function requiredRegexPattern(value: unknown): string {
  return requiredLimitedString(
    value,
    "rg_search requires a non-empty pattern string.",
    MAX_REGEX_PATTERN_BYTES,
  );
}

export function optionalLimitedString(
  value: unknown,
  maxBytes: number,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes("\0")) {
    throw new Error(`${name} cannot contain NUL bytes.`);
  }
  if (Buffer.byteLength(trimmed, "utf8") > maxBytes) {
    throw new Error(`${name} exceeds ${maxBytes} bytes.`);
  }
  return trimmed;
}

export function createLineRegex(pattern: string, flags: string): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`rg_search pattern is invalid: ${message}`);
  }
}

export function requiredPath(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(message);
  }
  if (value.includes("\0")) {
    throw new Error("path cannot contain NUL bytes.");
  }
  return value.trim();
}

export function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error("optional string value must be a string.");
  }
  if (value.includes("\0")) {
    throw new Error("optional string value cannot contain NUL bytes.");
  }
  return value.trim() || undefined;
}

export function optionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array of strings.`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`${name} entries must be non-empty strings.`);
    }
    if (entry.includes("\0")) {
      throw new Error(`${name} entries cannot contain NUL bytes.`);
    }
    return entry.trim();
  });
}

export function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

export function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean.`);
  }
  return value;
}

export function numberInRange(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function hasNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code;
}

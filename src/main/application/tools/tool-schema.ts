export interface ToolInputValidationResult {
  valid: boolean;
  message?: string;
}

/**
 * Validates the JSON-schema subset this runtime publishes to models before a
 * tool implementation or approval preview sees model-provided arguments. The
 * validator intentionally ignores unsupported schema keywords so MCP-provided
 * schemas cannot break execution only because they use a wider JSON Schema
 * dialect than the local runtime understands.
 */
export function validateToolInputSchema(
  toolName: string,
  schema: Record<string, unknown>,
  input: unknown,
): void {
  const error = validateSchemaNode(schema, input, "arguments");
  if (error) {
    throw new Error(`Tool "${toolName}" arguments do not match inputSchema: ${error}`);
  }
}

function validateSchemaNode(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
): string | undefined {
  const enumError = validateEnum(schema, value, path);
  if (enumError) return enumError;

  const typeError = validateType(schema, value, path);
  if (typeError) return typeError;

  if (shouldValidateObject(schema, value)) {
    const objectError = validateObject(schema, value, path);
    if (objectError) return objectError;
  }

  if (shouldValidateArray(schema, value)) {
    const arrayError = validateArray(schema, value, path);
    if (arrayError) return arrayError;
  }

  if (typeof value === "string") {
    const stringError = validateString(schema, value, path);
    if (stringError) return stringError;
  }

  if (typeof value === "number") {
    const numberError = validateNumber(schema, value, path);
    if (numberError) return numberError;
  }

  return undefined;
}

function validateEnum(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
): string | undefined {
  if (!Array.isArray(schema.enum)) return undefined;
  if (schema.enum.some((candidate) => isJsonEqual(candidate, value))) return undefined;
  return `${path} must be one of ${schema.enum.map(formatExpectedValue).join(", ")}.`;
}

function validateType(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
): string | undefined {
  const schemaTypes = schema.type;
  if (typeof schemaTypes !== "string" && !Array.isArray(schemaTypes)) {
    return undefined;
  }
  const supportedTypes = (Array.isArray(schemaTypes) ? schemaTypes : [schemaTypes])
    .filter(isSupportedJsonSchemaType);
  if (supportedTypes.length === 0 || supportedTypes.some((type) => matchesType(value, type))) {
    return undefined;
  }
  return `${path} must be ${formatTypeList(supportedTypes)}.`;
}

function validateObject(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
): string | undefined {
  if (!isRecord(value)) return undefined;
  if (Array.isArray(schema.required)) {
    for (const fieldName of schema.required) {
      if (typeof fieldName !== "string") continue;
      if (!Object.hasOwn(value, fieldName)) {
        return `${path}.${fieldName} is required.`;
      }
    }
  }
  if (!isRecord(schema.properties)) {
    return undefined;
  }
  for (const [fieldName, fieldSchema] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(value, fieldName) || !isRecord(fieldSchema)) continue;
    const nestedError = validateSchemaNode(fieldSchema, value[fieldName], `${path}.${fieldName}`);
    if (nestedError) return nestedError;
  }
  return undefined;
}

function validateArray(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
): string | undefined {
  if (!Array.isArray(value)) return undefined;
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    return `${path} must contain at least ${schema.minItems} item(s).`;
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    return `${path} must contain at most ${schema.maxItems} item(s).`;
  }
  if (!isRecord(schema.items)) return undefined;
  for (const [index, item] of value.entries()) {
    const itemError = validateSchemaNode(schema.items, item, `${path}[${index}]`);
    if (itemError) return itemError;
  }
  return undefined;
}

function validateString(
  schema: Record<string, unknown>,
  value: string,
  path: string,
): string | undefined {
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    return `${path} must contain at least ${schema.minLength} character(s).`;
  }
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    return `${path} must contain at most ${schema.maxLength} character(s).`;
  }
  return undefined;
}

function validateNumber(
  schema: Record<string, unknown>,
  value: number,
  path: string,
): string | undefined {
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    return `${path} must be at least ${schema.minimum}.`;
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    return `${path} must be at most ${schema.maximum}.`;
  }
  return undefined;
}

function shouldValidateObject(schema: Record<string, unknown>, value: unknown): boolean {
  return isRecord(value) && (schema.type === "object" || isRecord(schema.properties) || Array.isArray(schema.required));
}

function shouldValidateArray(schema: Record<string, unknown>, value: unknown): boolean {
  return Array.isArray(value) && (schema.type === "array" || isRecord(schema.items));
}

function matchesType(value: unknown, type: JsonSchemaType): boolean {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "null":
      return value === null;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return isRecord(value);
    case "string":
      return typeof value === "string";
  }
}

type JsonSchemaType = "array" | "boolean" | "integer" | "null" | "number" | "object" | "string";

function isSupportedJsonSchemaType(value: unknown): value is JsonSchemaType {
  return (
    value === "array" ||
    value === "boolean" ||
    value === "integer" ||
    value === "null" ||
    value === "number" ||
    value === "object" ||
    value === "string"
  );
}

function formatTypeList(types: readonly JsonSchemaType[]): string {
  return types.length === 1 ? types[0] : types.join(" or ");
}

function formatExpectedValue(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : JSON.stringify(value);
}

function isJsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

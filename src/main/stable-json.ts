export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value)) ?? "undefined";
}

export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalizeJson((value as Record<string, unknown>)[key]);
  }
  return out;
}

export function canonicalizeJsonRecord(value: unknown): Record<string, unknown> {
  const canonical = canonicalizeJson(value);
  return canonical && typeof canonical === "object" && !Array.isArray(canonical)
    ? (canonical as Record<string, unknown>)
    : {};
}

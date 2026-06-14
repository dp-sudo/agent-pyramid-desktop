/**
 * Shared malformed-line handling for JSONL replay loops. Both JsonlThreadStore
 * (streaming readline) and CheckpointStore (readFile + split) skip unparseable
 * lines instead of failing the whole thread; this keeps the warn format and
 * error-message extraction consistent so failures stay traceable.
 */
export function warnMalformedJsonlLine(
  label: string,
  lineNo: number,
  target: string,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(
    `[persistence] skipped malformed ${label} line ${lineNo} in ${target}:`,
    message,
  );
}

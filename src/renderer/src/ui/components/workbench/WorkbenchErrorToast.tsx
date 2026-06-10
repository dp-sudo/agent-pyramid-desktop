import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

export const WORKBENCH_DISMISS_BUTTON_TEXT = "x";
const WORKBENCH_ERROR_COPY_RESET_MS = 1600;

type WorkbenchErrorCopyState = "idle" | "copied" | "failed";
type WorkbenchErrorCopyFailureReason = "empty" | "unavailable" | "failed";

export type WorkbenchErrorCopyResult =
  | { ok: true }
  | { ok: false; reason: WorkbenchErrorCopyFailureReason; error?: unknown };

export interface WorkbenchErrorToastProps {
  message: string | null;
  enabled?: boolean;
  onDismiss: () => void;
  floating?: boolean;
}

export function WorkbenchErrorToast({
  message,
  enabled = true,
  onDismiss,
  floating = false,
}: WorkbenchErrorToastProps): ReactElement | null {
  const { t } = useTranslation();
  const [copyState, setCopyState] = useState<WorkbenchErrorCopyState>("idle");
  const copyResetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setCopyState("idle");
    return () => clearWorkbenchErrorCopyResetTimer(copyResetTimerRef);
  }, [message]);

  if (!shouldShowWorkbenchErrorToast(message, enabled)) return null;

  async function copyErrorMessage(): Promise<void> {
    const result = await copyWorkbenchErrorMessage(message);
    if (!result.ok) {
      console.warn(
        "[workbench] failed to copy error toast text:",
        result.error ?? result.reason,
      );
      setCopyState("failed");
      resetCopyStateLater(copyResetTimerRef, setCopyState);
      return;
    }

    setCopyState("copied");
    resetCopyStateLater(copyResetTimerRef, setCopyState);
  }

  const copyLabel = t("common.copyError");
  const copyText =
    copyState === "copied"
      ? t("common.copied")
      : copyState === "failed"
        ? t("common.copyFailed")
        : t("common.copy");

  const toastClassName = floating ? "ds-error-toast is-floating" : "ds-error-toast";

  return (
    <div className={toastClassName} role="status">
      <span className="ds-error-toast-message">{message}</span>
      <div className="ds-error-toast-actions">
        <button
          type="button"
          className="ds-error-toast-copy-button"
          onClick={() => void copyErrorMessage()}
          aria-label={copyLabel}
          title={copyLabel}
        >
          {copyText}
        </button>
        <button
          type="button"
          className="ds-error-toast-dismiss-button"
          onClick={onDismiss}
          aria-label={t("common.dismiss")}
          title={t("common.dismiss")}
        >
          {WORKBENCH_DISMISS_BUTTON_TEXT}
        </button>
      </div>
    </div>
  );
}

export function shouldShowWorkbenchErrorToast(
  message: string | null,
  enabled = true,
): boolean {
  return enabled && Boolean(message);
}

// Clipboard access stays in the renderer boundary; callers get a structured
// failure reason so the toast can expose copy errors instead of hiding them.
export async function copyWorkbenchErrorMessage(
  message: string | null,
  writeText?: (text: string) => Promise<void>,
): Promise<WorkbenchErrorCopyResult> {
  if (message === null || message.length === 0) return { ok: false, reason: "empty" };

  const clipboardWriteText =
    writeText ?? globalThis.navigator?.clipboard?.writeText?.bind(globalThis.navigator.clipboard);
  if (!clipboardWriteText) return { ok: false, reason: "unavailable" };

  try {
    await clipboardWriteText(message);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: "failed", error };
  }
}

function resetCopyStateLater(
  timerRef: { current: number | null },
  setCopyState: (state: WorkbenchErrorCopyState) => void,
): void {
  clearWorkbenchErrorCopyResetTimer(timerRef);
  timerRef.current = window.setTimeout(() => {
    timerRef.current = null;
    setCopyState("idle");
  }, WORKBENCH_ERROR_COPY_RESET_MS);
}

function clearWorkbenchErrorCopyResetTimer(timerRef: { current: number | null }): void {
  const timerId = timerRef.current;
  if (timerId === null) return;
  window.clearTimeout(timerId);
  timerRef.current = null;
}

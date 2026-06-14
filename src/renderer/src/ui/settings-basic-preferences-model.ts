import {
  CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_MAX,
  CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_MIN,
  type DefaultInspectorMode,
  type DefaultStartupView,
} from "./preferences";
import type { SettingsTranslator } from "./settings-runtime-model";

export const STARTUP_VIEWS: readonly DefaultStartupView[] = ["code", "write"];
export const DEFAULT_INSPECTOR_MODES: readonly DefaultInspectorMode[] = [
  null,
  "changes",
  "todo",
  "plan",
];

type BasicPreferenceDraftValidationResult =
  | { ok: true; value: number }
  | { ok: false; message: string };

export function validateCodeBlockCollapseLineThreshold(
  raw: string,
  t: SettingsTranslator,
): BasicPreferenceDraftValidationResult {
  const label = t("settings.fields.codeBlockCollapseLineThreshold");
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (!trimmed || !Number.isInteger(parsed) || parsed < 1) {
    return {
      ok: false,
      message: t("settings.errors.positiveInteger", { field: label }),
    };
  }
  if (
    parsed < CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_MIN ||
    parsed > CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_MAX
  ) {
    return {
      ok: false,
      message: t("settings.errors.integerRange", {
        field: label,
        min: CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_MIN,
        max: CODE_BLOCK_COLLAPSE_LINE_THRESHOLD_MAX,
      }),
    };
  }
  return { ok: true, value: parsed };
}

export function isDefaultStartupViewSetting(
  value: string,
): value is DefaultStartupView {
  return STARTUP_VIEWS.includes(value as DefaultStartupView);
}

export function toDefaultInspectorModeValue(mode: DefaultInspectorMode): string {
  return mode ?? "closed";
}

export function toDefaultInspectorMode(value: string): DefaultInspectorMode {
  if (value === "changes" || value === "todo" || value === "plan") return value;
  return null;
}

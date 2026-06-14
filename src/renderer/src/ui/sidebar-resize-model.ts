import {
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  LEFT_SIDEBAR_MAX_WIDTH,
  LEFT_SIDEBAR_MIN_WIDTH,
} from "./preferences";

export const LEFT_SIDEBAR_KEYBOARD_STEP = 16;

export function clampLeftSidebarWidth(width: number): number {
  return Math.min(LEFT_SIDEBAR_MAX_WIDTH, Math.max(LEFT_SIDEBAR_MIN_WIDTH, width));
}

export function getNextLeftSidebarWidth(
  currentWidth: number,
  key: string,
  step = LEFT_SIDEBAR_KEYBOARD_STEP,
): number {
  if (key === "ArrowLeft") return clampLeftSidebarWidth(currentWidth - step);
  if (key === "ArrowRight") return clampLeftSidebarWidth(currentWidth + step);
  if (key === "Home") return LEFT_SIDEBAR_MIN_WIDTH;
  if (key === "End") return LEFT_SIDEBAR_MAX_WIDTH;
  return currentWidth;
}

export function getResetLeftSidebarWidth(): number {
  return LEFT_SIDEBAR_DEFAULT_WIDTH;
}

export function getSidebarDividerClassName(
  isDragging: boolean,
  extraClassName?: string,
): string {
  const baseClassName = extraClassName
    ? `ds-workbench-divider ${extraClassName}`
    : "ds-workbench-divider";
  return isDragging ? `${baseClassName} is-dragging` : baseClassName;
}

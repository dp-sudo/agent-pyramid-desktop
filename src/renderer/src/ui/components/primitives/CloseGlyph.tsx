import type { ReactElement } from "react";

interface CloseGlyphProps {
  size?: number;
}

// 内联 close icon：16px 视区、1.5 描边宽度，居中对齐的 × 形。
// 替代 ASCII 字符 "x"，避免不同字体度量差异与编码降级。
export function CloseGlyph({ size = 12 }: CloseGlyphProps): ReactElement {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    >
      <path d="M3.5 3.5 L12.5 12.5" />
      <path d="M12.5 3.5 L3.5 12.5" />
    </svg>
  );
}

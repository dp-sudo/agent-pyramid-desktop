import type { ReactElement } from "react";

interface BrandMarkProps {
  size?: number;
}

// 产品 brand mark：pyramid 母题的简化三层三角形叠放，对应 "agent-pyramid"。
// 颜色使用 currentColor，让父级容器决定主题色（accent / text 等）。
export function BrandMark({ size = 18 }: BrandMarkProps): ReactElement {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      <path d="M9 2.4 L14.4 11.6 L3.6 11.6 Z" fill="currentColor" fillOpacity="0.18" />
      <path d="M9 7.6 L12.4 13 L5.6 13 Z" fill="currentColor" fillOpacity="0.32" />
      <path d="M9 11.6 L11 15.2 L7 15.2 Z" fill="currentColor" />
    </svg>
  );
}

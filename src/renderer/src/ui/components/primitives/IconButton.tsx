import type { ReactElement, ReactNode } from "react";

interface IconButtonProps {
  children: ReactNode;
  onClick?: () => void;
  title?: string;
  "aria-label"?: string;
  disabled?: boolean;
}

export function IconButton({ children, onClick, title, disabled, ...rest }: IconButtonProps): ReactElement {
  return (
    <button
      type="button"
      className="ds-pill"
      onClick={onClick}
      title={title}
      disabled={disabled}
      aria-label={rest["aria-label"] ?? title}
    >
      {children}
    </button>
  );
}

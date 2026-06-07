import type { ReactElement, ReactNode } from "react";

interface PillProps {
  children: ReactNode;
  onClick?: () => void;
  accent?: boolean;
  title?: string;
  disabled?: boolean;
}

export function Pill({ children, onClick, accent, title, disabled }: PillProps): ReactElement {
  return (
    <button
      type="button"
      className={`ds-pill ${accent ? "is-accent" : ""}`}
      onClick={onClick}
      title={title}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

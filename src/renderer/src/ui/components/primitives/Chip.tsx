import type { ReactElement, ReactNode } from "react";

interface ChipProps {
  children: ReactNode;
  tone?: "default" | "accent" | "danger" | "success";
}

export function Chip({ children, tone = "default" }: ChipProps): ReactElement {
  const color =
    tone === "accent"
      ? "var(--ds-accent)"
      : tone === "danger"
        ? "var(--ds-danger)"
        : tone === "success"
          ? "var(--ds-success)"
          : "var(--ds-text-muted)";
  return (
    <span
      className="ds-pill"
      style={{
        color,
        background: "var(--ds-surface-subtle)",
        border: "1px solid var(--ds-border-muted)",
      }}
    >
      {children}
    </span>
  );
}

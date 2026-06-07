import type { ReactElement, ReactNode } from "react";

export function KbdHint({ children }: { children: ReactNode }): ReactElement {
  return <kbd className="ds-pill" style={{ fontFamily: "var(--ds-font-mono)" }}>{children}</kbd>;
}

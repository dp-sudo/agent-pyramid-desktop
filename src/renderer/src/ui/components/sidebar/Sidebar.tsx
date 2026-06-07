import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../store/WorkbenchContext";
import type { ThreadSummary } from "../../../../../shared/agent-contracts";

interface SidebarProps {
  threads: ThreadSummary[];
  activeView: "code" | "write";
  onSelectThread: (id: string) => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
}

export function Sidebar({
  threads,
  activeView,
  onSelectThread,
  onNewChat,
  onOpenSettings,
}: SidebarProps): ReactElement {
  const { t } = useTranslation();
  const { state } = useWorkbench();
  return (
    <aside className="ds-sidebar">
      <div style={{ padding: "12px 12px 8px" }}>
        <button type="button" className="ds-pill is-accent" onClick={onNewChat} style={{ width: "100%", justifyContent: "center" }}>
          {t("threads.newChat")}
        </button>
      </div>
      <div className="ds-sidebar-list">
        {threads.length === 0 ? (
          <div style={{ padding: "12px 8px", color: "var(--ds-text-faint)", fontSize: "var(--ds-size-caption)" }}>
            {t("threads.empty")}
          </div>
        ) : null}
        {threads.map((thread) => (
          <div
            key={thread.id}
            className={`ds-sidebar-row ${state.activeThreadId === thread.id ? "is-active" : ""}`}
            onClick={() => onSelectThread(thread.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") onSelectThread(thread.id);
            }}
          >
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {thread.title}
            </span>
            <span style={{ fontSize: "var(--ds-size-caption)", color: "var(--ds-text-faint)" }}>
              {new Date(thread.updatedAt).toLocaleTimeString()}
            </span>
          </div>
        ))}
      </div>
      <div style={{ padding: 12, borderTop: "1px solid var(--ds-border-muted)", display: "flex", gap: 6 }}>
        <button type="button" className="ds-pill" onClick={onOpenSettings}>
          {t("common.settings")}
        </button>
        <span className="ds-pill" style={{ marginLeft: "auto", color: "var(--ds-text-faint)" }}>
          {activeView === "code" ? t("routes.code") : t("routes.write")}
        </span>
      </div>
    </aside>
  );
}

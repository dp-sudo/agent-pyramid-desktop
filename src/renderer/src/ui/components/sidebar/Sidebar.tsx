import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../store/WorkbenchContext";
import type { ThreadSummary } from "../../../../../shared/agent-contracts";

interface SidebarProps {
  threads: ThreadSummary[];
  activeView: "code" | "write";
  onSelectThread: (id: string) => void;
  onNewChat: () => void;
  onPickWorkspace: () => void;
  onDeleteThread: (id: string) => void;
  onArchiveThread: (id: string) => void;
  onRestoreThread: (id: string) => void;
  onOpenSettings: () => void;
  workspaceRoot: string;
  showArchivedThreads: boolean;
  onToggleArchivedThreads: () => void;
}

export function Sidebar({
  threads,
  activeView,
  onSelectThread,
  onNewChat,
  onPickWorkspace,
  onDeleteThread,
  onArchiveThread,
  onRestoreThread,
  onOpenSettings,
  workspaceRoot,
  showArchivedThreads,
  onToggleArchivedThreads,
}: SidebarProps): ReactElement {
  const { t } = useTranslation();
  const { state } = useWorkbench();
  const groups = groupThreadsByWorkspace(threads);

  return (
    <aside className="ds-sidebar">
      <div className="ds-sidebar-header">
        <button
          type="button"
          className="ds-pill is-accent"
          onClick={onNewChat}
          style={{ width: "100%", justifyContent: "center" }}
        >
          {t("threads.newChat")}
        </button>
        <button
          type="button"
          className="ds-pill"
          onClick={onPickWorkspace}
          style={{ width: "100%", justifyContent: "center" }}
        >
          {t("threads.changeWorkspace")}
        </button>
        <div className="ds-sidebar-workspace" title={workspaceRoot || t("threads.noWorkspace")}>
          {workspaceRoot || t("threads.noWorkspace")}
        </div>
        <button
          type="button"
          className="ds-sidebar-archive-toggle"
          onClick={onToggleArchivedThreads}
        >
          {showArchivedThreads ? t("threads.hideArchived") : t("threads.showArchived")}
        </button>
      </div>

      <div className="ds-sidebar-list">
        {threads.length === 0 ? (
          <div className="ds-sidebar-empty">{t("threads.empty")}</div>
        ) : null}
        {groups.map((group) => (
          <section key={group.workspace || "empty"} className="ds-sidebar-project-group">
            <div className="ds-sidebar-project-title" title={group.workspace}>
              {group.workspace || t("threads.noWorkspace")}
            </div>
            {group.threads.map((thread) => {
              const isArchived = thread.status === "archived";
              return (
                <div
                  key={thread.id}
                  className={`ds-sidebar-row ${
                    state.activeThreadId === thread.id ? "is-active" : ""
                  } ${isArchived ? "is-archived" : ""}`}
                  onClick={() => onSelectThread(thread.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      onSelectThread(thread.id);
                    }
                  }}
                >
                  <span className="ds-sidebar-row-title">{thread.title}</span>
                  <span className="ds-sidebar-row-time">
                    {new Date(thread.updatedAt).toLocaleTimeString()}
                  </span>
                  <button
                    type="button"
                    className="ds-sidebar-row-action"
                    title={isArchived ? t("threads.restore") : t("threads.archive")}
                    aria-label={isArchived ? t("threads.restore") : t("threads.archive")}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (isArchived) onRestoreThread(thread.id);
                      else onArchiveThread(thread.id);
                    }}
                  >
                    {isArchived ? t("threads.restoreShort") : t("threads.archiveShort")}
                  </button>
                  <button
                    type="button"
                    className="ds-sidebar-delete-button"
                    title={t("threads.delete")}
                    aria-label={t("threads.delete")}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDeleteThread(thread.id);
                    }}
                  >
                    {t("threads.deleteShort")}
                  </button>
                </div>
              );
            })}
          </section>
        ))}
      </div>

      <div className="ds-sidebar-footer">
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

interface ThreadGroup {
  workspace: string;
  threads: ThreadSummary[];
}

function groupThreadsByWorkspace(threads: ThreadSummary[]): ThreadGroup[] {
  const groups = new Map<string, ThreadSummary[]>();
  for (const thread of threads) {
    const workspace = thread.workspace.trim();
    const existing = groups.get(workspace);
    if (existing) existing.push(thread);
    else groups.set(workspace, [thread]);
  }
  return [...groups.entries()].map(([workspace, groupedThreads]) => ({
    workspace,
    threads: groupedThreads,
  }));
}

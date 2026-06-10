import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench, type WorkbenchRoute } from "../../store/WorkbenchContext";
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
  onSwitchWorkbench: (route: Extract<WorkbenchRoute, "code" | "write">) => void;
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
  onSwitchWorkbench,
  workspaceRoot,
  showArchivedThreads,
  onToggleArchivedThreads,
}: SidebarProps): ReactElement {
  const { t } = useTranslation();
  const { state } = useWorkbench();
  const groups = groupThreadsByWorkspace(threads);
  const [pendingDeleteThreadId, setPendingDeleteThreadId] = useState<string | null>(null);

  useEffect(() => {
    setPendingDeleteThreadId((current) => prunePendingThreadDeleteId(current, threads));
  }, [threads]);

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
              const isActive = state.activeThreadId === thread.id;
              const isConfirmingDelete = isThreadDeletePending(
                pendingDeleteThreadId,
                thread.id,
              );
              return (
                <article
                  key={thread.id}
                  className={`ds-sidebar-row ${
                    isActive ? "is-active" : ""
                  } ${isArchived ? "is-archived" : ""} ${
                    isConfirmingDelete ? "is-confirming-delete" : ""
                  }`}
                >
                  <button
                    type="button"
                    className="ds-sidebar-row-main"
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => {
                      setPendingDeleteThreadId(null);
                      onSelectThread(thread.id);
                    }}
                  >
                    <span className="ds-sidebar-row-title">{thread.title}</span>
                    <span className="ds-sidebar-row-time">
                      {formatThreadTime(thread.updatedAt)}
                    </span>
                  </button>
                  {isConfirmingDelete ? (
                    <div
                      className="ds-sidebar-delete-confirm"
                      role="group"
                      aria-label={t("threads.deleteConfirm", { title: thread.title })}
                    >
                      <span>{t("threads.deleteConfirmShort")}</span>
                      <button
                        type="button"
                        className="ds-sidebar-delete-button is-danger"
                        onClick={() => {
                          setPendingDeleteThreadId(null);
                          onDeleteThread(thread.id);
                        }}
                      >
                        {t("threads.deleteConfirmAction")}
                      </button>
                      <button
                        type="button"
                        className="ds-sidebar-row-action"
                        onClick={() => setPendingDeleteThreadId(null)}
                      >
                        {t("common.cancel")}
                      </button>
                    </div>
                  ) : (
                    <div className="ds-sidebar-row-actions">
                      <button
                        type="button"
                        className="ds-sidebar-row-action"
                        title={isArchived ? t("threads.restore") : t("threads.archive")}
                        aria-label={isArchived ? t("threads.restore") : t("threads.archive")}
                        onClick={() => {
                          setPendingDeleteThreadId(null);
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
                        onClick={() => setPendingDeleteThreadId(thread.id)}
                      >
                        {t("threads.deleteShort")}
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </section>
        ))}
      </div>

      <div className="ds-sidebar-footer">
        <button type="button" className="ds-pill" onClick={onOpenSettings}>
          {t("common.settings")}
        </button>
        <div
          className="ds-sidebar-workbench-switch"
          role="group"
          aria-label={t("routes.switchWorkbench")}
        >
          {getWorkbenchSwitchOptions(activeView).map((option) => (
            <button
              key={option.route}
              type="button"
              className={`ds-sidebar-workbench-button ${
                option.active ? "is-active" : ""
              }`}
              aria-pressed={option.active}
              onClick={() => {
                if (!option.active) onSwitchWorkbench(option.route);
              }}
            >
              {t(option.labelKey)}
            </button>
          ))}
        </div>
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

export function formatThreadTime(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function isThreadDeletePending(
  pendingDeleteThreadId: string | null,
  threadId: string,
): boolean {
  return pendingDeleteThreadId === threadId;
}

export function prunePendingThreadDeleteId(
  pendingDeleteThreadId: string | null,
  threads: readonly Pick<ThreadSummary, "id">[],
): string | null {
  if (!pendingDeleteThreadId) return null;
  return threads.some((thread) => thread.id === pendingDeleteThreadId)
    ? pendingDeleteThreadId
    : null;
}

export function getWorkbenchSwitchOptions(
  activeView: "code" | "write",
): Array<{
  route: Extract<WorkbenchRoute, "code" | "write">;
  labelKey: "routes.code" | "routes.write";
  active: boolean;
}> {
  return [
    { route: "code", labelKey: "routes.code", active: activeView === "code" },
    { route: "write", labelKey: "routes.write", active: activeView === "write" },
  ];
}

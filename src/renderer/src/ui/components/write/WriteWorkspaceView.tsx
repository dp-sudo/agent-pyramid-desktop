import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../store/WorkbenchContext";
import type { WriteFileEntry } from "../../../../../shared/agent-contracts";

export function WriteWorkspaceView(): ReactElement {
  const { t } = useTranslation();
  const { state, actions } = useWorkbench();
  const [files, setFiles] = useState<WriteFileEntry[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "saving" | "saved" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function pickWorkspace(): Promise<string | null> {
    const result = await window.agentApi.workspace.pickDirectory();
    if (!result.ok) {
      setErrorMessage(result.message);
      setStatus("error");
      return null;
    }
    if (result.value.canceled || !result.value.path) return null;
    actions.setWorkspaceRoot(result.value.path);
    return result.value.path;
  }

  async function loadList(workspaceInput?: string): Promise<void> {
    const workspace = workspaceInput ?? await pickWorkspace();
    if (!workspace) return;
    const switchingWorkspace = workspace !== state.workspaceRoot;
    setStatus("loading");
    const result = await window.agentApi.write.list({ workspace, search: "" });
    if (result.ok) {
      setFiles(result.value);
      if (switchingWorkspace) {
        setActivePath(null);
        setContent("");
      }
      setStatus("idle");
      setErrorMessage(null);
    } else {
      setErrorMessage(result.message);
      setStatus("error");
    }
  }

  async function openFile(path: string): Promise<void> {
    if (!state.workspaceRoot) return;
    setActivePath(path);
    setStatus("loading");
    const result = await window.agentApi.write.get({ workspace: state.workspaceRoot, path });
    if (result.ok) {
      setContent(result.value.content);
      setStatus("idle");
      setErrorMessage(null);
    } else {
      setErrorMessage(result.message);
      setStatus("error");
    }
  }

  useEffect(() => {
    if (status !== "saved") return;
    const timer = window.setTimeout(() => setStatus("idle"), 1500);
    return () => window.clearTimeout(timer);
  }, [status]);

  async function save(): Promise<void> {
    if (!activePath || !state.workspaceRoot) return;
    setStatus("saving");
    const result = await window.agentApi.write.put({
      workspace: state.workspaceRoot,
      path: activePath,
      content,
    });
    if (result.ok) {
      setStatus("saved");
      setErrorMessage(null);
    } else {
      setErrorMessage(result.message);
      setStatus("error");
    }
  }

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <aside
        style={{
          width: state.leftSidebarWidth,
          background: "var(--ds-bg-sidebar)",
          borderRight: "1px solid var(--ds-border-muted)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <div style={{ padding: 12, display: "flex", gap: 6 }}>
          <button className="ds-pill" onClick={() => void loadList()}>
            {t("write.openWorkspace")}
          </button>
          {state.workspaceRoot ? (
            <button
              className="ds-pill"
              onClick={() => void loadList(state.workspaceRoot)}
            >
              {t("write.refresh")}
            </button>
          ) : null}
        </div>
        {state.workspaceRoot ? (
          <div
            className="ds-sidebar-workspace"
            style={{ margin: "0 12px 8px" }}
            title={state.workspaceRoot}
          >
            {state.workspaceRoot}
          </div>
        ) : null}
        <div className="ds-sidebar-list">
          {files.map((file) => (
            <div
              key={file.path}
              className={`ds-sidebar-row ${file.path === activePath ? "is-active" : ""}`}
              onClick={() => void openFile(file.path)}
            >
              {file.path}
            </div>
          ))}
        </div>
      </aside>
      <div className="ds-write-editor">
        <textarea
          value={content}
          onChange={(event) => {
            setContent(event.target.value);
            actions.setComposerText(event.target.value);
          }}
          placeholder={t("write.editorPlaceholder")}
        />
        <div className="ds-write-status">
          {status === "saving" ? t("write.saving") : null}
          {status === "saved" ? t("write.saved") : null}
          {status === "error" ? `${t("write.error")}: ${errorMessage ?? ""}` : null}
          {status === "idle" && activePath ? t("write.activeFile", { path: activePath }) : null}
          <button
            className="ds-pill is-accent"
            style={{ float: "right" }}
            onClick={() => void save()}
            disabled={!activePath || !state.workspaceRoot}
          >
            {t("write.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

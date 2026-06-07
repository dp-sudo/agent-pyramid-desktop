import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../store/WorkbenchContext";
import type { WriteFileEntry } from "../../../../../shared/agent-contracts";

const AUTOSAVE_DELAY_MS = 800;
const COMPLETION_DELAY_MS = 650;
const COMPLETION_MIN_TRAILING_CHARS = 10;

export function WriteWorkspaceView(): ReactElement {
  const { t } = useTranslation();
  const { state, actions } = useWorkbench();
  const [files, setFiles] = useState<WriteFileEntry[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [search, setSearch] = useState("");
  const [completion, setCompletion] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "saving" | "saved" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const completionRequestId = useRef(0);
  const listRequestId = useRef(0);
  const activePathRef = useRef<string | null>(null);
  const workspaceRootRef = useRef("");
  const contentRef = useRef("");
  const savedContentRef = useRef("");
  const saveInFlightRef = useRef(false);
  const pendingSaveRef = useRef(false);

  useEffect(() => {
    activePathRef.current = activePath;
    workspaceRootRef.current = state.workspaceRoot;
    contentRef.current = content;
    savedContentRef.current = savedContent;
  }, [activePath, content, savedContent, state.workspaceRoot]);

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

  async function loadList(workspaceInput?: string, searchInput = search): Promise<void> {
    const workspace = workspaceInput ?? await pickWorkspace();
    if (!workspace) return;
    const requestId = listRequestId.current + 1;
    listRequestId.current = requestId;
    const switchingWorkspace = workspace !== state.workspaceRoot;
    setStatus("loading");
    const result = await window.agentApi.write.list({ workspace, search: searchInput });
    if (requestId !== listRequestId.current) return;
    if (result.ok) {
      setFiles(result.value);
      if (switchingWorkspace) {
        setActivePath(null);
        setContent("");
        setSavedContent("");
        setCompletion("");
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
      contentRef.current = result.value.content;
      savedContentRef.current = result.value.content;
      setContent(result.value.content);
      setSavedContent(result.value.content);
      setCompletion("");
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

  useEffect(() => {
    if (!activePath || !state.workspaceRoot) return;
    if (content === savedContent) return;
    const timer = window.setTimeout(() => {
      void save();
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [activePath, content, savedContent, state.workspaceRoot]);

  useEffect(() => {
    if (!activePath || !state.workspaceRoot) {
      completionRequestId.current += 1;
      setCompletion("");
      return;
    }
    if (content.length < COMPLETION_MIN_TRAILING_CHARS) {
      completionRequestId.current += 1;
      setCompletion("");
      return;
    }
    const requestId = completionRequestId.current + 1;
    completionRequestId.current = requestId;
    const timer = window.setTimeout(() => {
      void requestCompletion(requestId);
    }, COMPLETION_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [activePath, content, state.workspaceRoot]);

  async function save(): Promise<void> {
    if (!activePathRef.current || !workspaceRootRef.current) return;
    if (saveInFlightRef.current) {
      pendingSaveRef.current = true;
      return;
    }
    await flushSave();
  }

  async function flushSave(): Promise<void> {
    const savingPath = activePathRef.current;
    const savingWorkspace = workspaceRootRef.current;
    if (!savingPath || !savingWorkspace) return;
    const nextContent = contentRef.current;
    if (nextContent === savedContentRef.current) return;

    saveInFlightRef.current = true;
    setStatus("saving");
    try {
      const result = await window.agentApi.write.put({
        workspace: savingWorkspace,
        path: savingPath,
        content: nextContent,
      });
      if (activePathRef.current === savingPath && workspaceRootRef.current === savingWorkspace) {
        if (result.ok) {
          savedContentRef.current = nextContent;
          setSavedContent(nextContent);
          setStatus(contentRef.current === nextContent ? "saved" : "saving");
          setErrorMessage(null);
        } else {
          setErrorMessage(result.message);
          setStatus("error");
        }
      }
    } catch (error) {
      if (activePathRef.current === savingPath && workspaceRootRef.current === savingWorkspace) {
        setErrorMessage(messageOf(error));
        setStatus("error");
      }
    } finally {
      saveInFlightRef.current = false;
      if (contentRef.current !== nextContent) {
        pendingSaveRef.current = true;
      }
      if (pendingSaveRef.current) {
        pendingSaveRef.current = false;
        void flushSave();
      }
    }
  }

  async function requestCompletion(requestId: number): Promise<void> {
    if (!activePath || !state.workspaceRoot) return;
    const result = await window.agentApi.write.complete({
      workspace: state.workspaceRoot,
      path: activePath,
      prefix: content,
      suffix: "",
    });
    if (requestId !== completionRequestId.current) return;
    if (result.ok) {
      setCompletion(result.value.score > 0 ? result.value.completion : "");
      return;
    }
    setCompletion("");
    setErrorMessage(result.message);
    setStatus("error");
  }

  function handleEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Tab" && completion) {
      event.preventDefault();
      const nextContent = `${content}${completion}`;
      contentRef.current = nextContent;
      setContent(nextContent);
      actions.setComposerText(nextContent);
      setCompletion("");
      return;
    }
    if (event.key === "Escape" && completion) {
      event.preventDefault();
      setCompletion("");
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
              onClick={() => void loadList(state.workspaceRoot, search)}
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
        <div className="ds-write-search">
          <input
            value={search}
            onChange={(event) => {
              const nextSearch = event.target.value;
              setSearch(nextSearch);
              if (state.workspaceRoot) {
                void loadList(state.workspaceRoot, nextSearch);
              }
            }}
            placeholder={t("write.searchPlaceholder")}
          />
        </div>
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
        <div className="ds-write-editor-frame">
          <textarea
            value={content}
            onChange={(event) => {
              const nextContent = event.target.value;
              contentRef.current = nextContent;
              setContent(nextContent);
              setCompletion("");
              actions.setComposerText(nextContent);
            }}
            onKeyDown={handleEditorKeyDown}
            placeholder={t("write.editorPlaceholder")}
          />
          {completion ? <div className="ds-write-ghost">{completion}</div> : null}
        </div>
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

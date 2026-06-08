import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../store/WorkbenchContext";
import type { WriteFileEntry } from "../../../../../shared/agent-contracts";

const AUTOSAVE_DELAY_MS = 800;
const COMPLETION_DELAY_MS = 650;
const COMPLETION_MIN_TRAILING_CHARS = 10;
type WriteStatus = "idle" | "loading" | "saving" | "saved" | "error";

export function WriteWorkspaceView(): ReactElement {
  const { t } = useTranslation();
  const { state, actions } = useWorkbench();
  const [files, setFiles] = useState<WriteFileEntry[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [search, setSearch] = useState("");
  const [completion, setCompletion] = useState("");
  const [status, setStatus] = useState<WriteStatus>("idle");
  const [listLoading, setListLoading] = useState(false);
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
    setListLoading(true);
    setStatus("loading");
    try {
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
    } catch (error) {
      if (requestId === listRequestId.current) {
        setErrorMessage(messageOf(error));
        setStatus("error");
      }
    } finally {
      if (requestId === listRequestId.current) {
        setListLoading(false);
      }
    }
  }

  function handleClearSearch(): void {
    setSearch("");
    if (state.workspaceRoot) {
      void loadList(state.workspaceRoot, "");
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

  const saveDisabled = shouldDisableWriteSave({
    activePath,
    workspaceRoot: state.workspaceRoot,
    content,
    savedContent,
    status,
  });
  const listState = getWriteListState({
    files,
    listLoading,
    search,
    workspaceRoot: state.workspaceRoot,
  });

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
        <div className="ds-write-route-actions">
          <button
            type="button"
            className="ds-pill"
            onClick={() => actions.setRoute("code")}
          >
            {t("routes.code")}
          </button>
          <button
            type="button"
            className="ds-pill"
            onClick={() => actions.setRoute("settings")}
          >
            {t("common.settings")}
          </button>
        </div>
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
          {search ? (
            <button
              type="button"
              className="ds-write-search-clear"
              onClick={handleClearSearch}
              aria-label={t("write.clearSearch")}
              title={t("write.clearSearch")}
            >
              ×
            </button>
          ) : null}
        </div>
        <div className="ds-sidebar-list">
          {listState === "loading" ? (
            <div className="ds-sidebar-empty">{t("write.loadingFiles")}</div>
          ) : null}
          {listState === "no-workspace" ? (
            <div className="ds-sidebar-empty">{t("write.noWorkspace")}</div>
          ) : null}
          {listState === "empty" ? (
            <div className="ds-sidebar-empty">{t("write.emptyFiles")}</div>
          ) : null}
          {listState === "empty-search" ? (
            <div className="ds-sidebar-empty">{t("write.emptySearch", { search })}</div>
          ) : null}
          {files.map((file) => (
            <button
              key={file.path}
              type="button"
              className={`ds-write-file-row ${file.path === activePath ? "is-active" : ""}`}
              onClick={() => void openFile(file.path)}
              title={`${file.path} · ${formatWriteFileMeta(file)}`}
            >
              <span>{file.path}</span>
              <small>{formatWriteFileMeta(file)}</small>
            </button>
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
          {status === "idle" && !activePath ? t("write.noActiveFile") : null}
          <button
            className="ds-pill is-accent"
            style={{ float: "right" }}
            onClick={() => void save()}
            disabled={saveDisabled}
          >
            {content !== savedContent ? t("write.save") : t("write.saved")}
          </button>
        </div>
      </div>
    </div>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface WriteSaveStateInput {
  activePath: string | null;
  workspaceRoot: string;
  content: string;
  savedContent: string;
  status: WriteStatus;
}

export function shouldDisableWriteSave(input: WriteSaveStateInput): boolean {
  return (
    !input.activePath ||
    !input.workspaceRoot ||
    input.status === "loading" ||
    input.status === "saving" ||
    input.content === input.savedContent
  );
}

export type WriteListState = "loading" | "no-workspace" | "empty" | "empty-search" | "ready";

export function getWriteListState(input: {
  files: WriteFileEntry[];
  listLoading: boolean;
  search: string;
  workspaceRoot: string;
}): WriteListState {
  if (input.listLoading) return "loading";
  if (!input.workspaceRoot) return "no-workspace";
  if (input.files.length > 0) return "ready";
  return input.search.trim() ? "empty-search" : "empty";
}

export function formatWriteFileMeta(file: WriteFileEntry): string {
  return `${formatBytes(file.size)} · ${formatDate(file.modifiedAt)}`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString();
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 102.4) / 10} KB`;
  return `${Math.round(value / 1024 / 102.4) / 10} MB`;
}

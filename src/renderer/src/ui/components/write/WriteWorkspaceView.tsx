import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench, type WorkbenchRoute } from "../../store/WorkbenchContext";
import { ChatBlock } from "../chat/ChatBlock";
import type { Item, WriteFileEntry } from "../../../../../shared/agent-contracts";

const AUTOSAVE_DELAY_MS = 800;
const COMPLETION_DELAY_MS = 650;
const WRITE_SEARCH_DEBOUNCE_MS = 250;
const COMPLETION_MIN_TRAILING_CHARS = 10;
export const WRITE_SEARCH_CLEAR_BUTTON_TEXT = "x";
type WriteStatus = "idle" | "loading" | "saving" | "saved" | "error";

export interface WriteAssistantPromptPayload {
  text: string;
  displayText: string;
  threadTitle: string;
}

export interface WriteWorkspaceViewProps {
  onWorkspaceSelected?: (workspace: string) => boolean | void | Promise<boolean | void>;
  onSendAssistantPrompt?: (payload: WriteAssistantPromptPayload) => Promise<boolean>;
  onInterruptAssistant?: () => void;
  assistantBusy?: boolean;
}

export function WriteWorkspaceView({
  onWorkspaceSelected,
  onSendAssistantPrompt,
  onInterruptAssistant,
  assistantBusy = false,
}: WriteWorkspaceViewProps = {}): ReactElement {
  const { t } = useTranslation();
  const { state, actions } = useWorkbench();
  const [files, setFiles] = useState<WriteFileEntry[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [search, setSearch] = useState("");
  const [completion, setCompletion] = useState("");
  const [assistantDraft, setAssistantDraft] = useState("");
  const [assistantSending, setAssistantSending] = useState(false);
  const [status, setStatus] = useState<WriteStatus>("idle");
  const [listLoading, setListLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const completionRequestId = useRef(0);
  const listRequestId = useRef(0);
  const openFileRequestId = useRef(0);
  const activePathRef = useRef<string | null>(null);
  const workspaceRootRef = useRef("");
  const contentRef = useRef("");
  const savedContentRef = useRef("");
  const saveInFlightRef = useRef(false);
  const savePromiseRef = useRef<Promise<boolean> | null>(null);
  const searchDebounceTimerRef = useRef<number | null>(null);
  const assistantMessagesRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activePathRef.current = activePath;
    workspaceRootRef.current = state.workspaceRoot;
    contentRef.current = content;
    savedContentRef.current = savedContent;
  }, [activePath, content, savedContent, state.workspaceRoot]);

  const assistantItems = getWriteAssistantVisibleItems(state.items);
  const assistantSubmitDisabled = (
    !onSendAssistantPrompt ||
    !canSubmitWriteAssistantPrompt({
      prompt: assistantDraft,
      workspaceRoot: state.workspaceRoot,
      sending: assistantSending || assistantBusy,
    })
  );

  useEffect(() => {
    const element = assistantMessagesRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [assistantBusy, state.items]);

  async function pickWorkspace(): Promise<string | null> {
    const result = await window.agentApi.workspace.pickDirectory();
    if (!result.ok) {
      setErrorMessage(result.message);
      setStatus("error");
      return null;
    }
    if (result.value.canceled || !result.value.path) return null;
    try {
      if (!await shouldUseSelectedWriteWorkspace(result.value.path, onWorkspaceSelected)) {
        setErrorMessage(t("write.workspaceSelectionFailed"));
        setStatus("error");
        return null;
      }
    } catch (error) {
      setErrorMessage(messageOf(error));
      setStatus("error");
      return null;
    }
    actions.setWorkspaceRoot(result.value.path);
    return result.value.path;
  }

  async function loadList(
    workspaceInput?: string,
    searchInput = search,
    options: { saveBeforeLoad?: boolean } = {},
  ): Promise<void> {
    if (options.saveBeforeLoad && !(await saveCurrentFileBeforeSwitch())) return;
    const workspace = workspaceInput ?? await pickWorkspace();
    if (!workspace) return;
    const requestId = listRequestId.current + 1;
    listRequestId.current = requestId;
    const switchingWorkspace = workspace !== state.workspaceRoot;
    if (switchingWorkspace) {
      openFileRequestId.current += 1;
      // A workspace boundary invalidates all file-relative state even if listing fails.
      const clearedState = getWriteWorkspaceSwitchState();
      setFiles(clearedState.files);
      activePathRef.current = clearedState.activePath;
      contentRef.current = clearedState.content;
      savedContentRef.current = clearedState.savedContent;
      setActivePath(clearedState.activePath);
      setContent(clearedState.content);
      setSavedContent(clearedState.savedContent);
      setCompletion(clearedState.completion);
    }
    setListLoading(true);
    setStatus("loading");
    try {
      const result = await window.agentApi.write.list({ workspace, search: searchInput });
      if (requestId !== listRequestId.current) return;
      if (result.ok) {
        setFiles(result.value);
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

  function clearSearchDebounceTimer(): void {
    if (searchDebounceTimerRef.current === null) return;
    window.clearTimeout(searchDebounceTimerRef.current);
    searchDebounceTimerRef.current = null;
  }

  function handleClearSearch(): void {
    clearSearchDebounceTimer();
    setSearch("");
    if (state.workspaceRoot) {
      void loadList(state.workspaceRoot, "", { saveBeforeLoad: false });
    }
  }

  async function openFile(path: string): Promise<void> {
    const workspace = state.workspaceRoot;
    if (!workspace) return;
    if (path === activePathRef.current) return;
    if (!(await saveCurrentFileBeforeSwitch())) return;
    const requestId = openFileRequestId.current + 1;
    openFileRequestId.current = requestId;
    setStatus("loading");
    const result = await window.agentApi.write.get({ workspace, path });
    // Protect the user's latest open-file intent: IPC responses can resolve out of order.
    if (!shouldApplyWriteOpenResult({
      requestId,
      latestRequestId: openFileRequestId.current,
      requestedWorkspace: workspace,
      currentWorkspace: workspaceRootRef.current,
      requestedPath: path,
      returnedPath: result.ok ? result.value.path : undefined,
    })) {
      return;
    }
    if (result.ok) {
      activePathRef.current = path;
      contentRef.current = result.value.content;
      savedContentRef.current = result.value.content;
      setActivePath(path);
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
    return () => clearSearchDebounceTimer();
  }, []);

  useEffect(() => {
    if (!shouldWarnBeforeLeavingWriteDocument({
      activePath,
      workspaceRoot: state.workspaceRoot,
      content,
      savedContent,
    })) {
      return undefined;
    }

    function handleBeforeUnload(event: BeforeUnloadEvent): void {
      event.preventDefault();
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [activePath, content, savedContent, state.workspaceRoot]);

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
      await savePromiseRef.current;
      return;
    }
    await flushSave();
  }

  async function saveCurrentFileBeforeSwitch(): Promise<boolean> {
    if (!shouldSaveWriteFileBeforeSwitch({
      activePath: activePathRef.current,
      workspaceRoot: workspaceRootRef.current,
      content: contentRef.current,
      savedContent: savedContentRef.current,
    })) {
      return true;
    }
    if (saveInFlightRef.current) {
      await savePromiseRef.current;
      return contentRef.current === savedContentRef.current;
    }
    return flushSave();
  }

  async function navigateFromWrite(
    route: Extract<WorkbenchRoute, "code" | "settings">,
  ): Promise<void> {
    if (!(await saveCurrentFileBeforeSwitch())) return;
    actions.setRoute(route);
  }

  async function flushSave(): Promise<boolean> {
    if (savePromiseRef.current) return savePromiseRef.current;
    savePromiseRef.current = flushSaveNow();
    try {
      return await savePromiseRef.current;
    } finally {
      savePromiseRef.current = null;
    }
  }

  async function flushSaveNow(): Promise<boolean> {
    while (true) {
      const savingPath = activePathRef.current;
      const savingWorkspace = workspaceRootRef.current;
      if (!savingPath || !savingWorkspace) return true;
      const nextContent = contentRef.current;
      if (nextContent === savedContentRef.current) return true;

      saveInFlightRef.current = true;
      setStatus("saving");
      try {
        const result = await window.agentApi.write.put({
          workspace: savingWorkspace,
          path: savingPath,
          content: nextContent,
        });
        if (activePathRef.current !== savingPath || workspaceRootRef.current !== savingWorkspace) {
          return false;
        }
        if (!result.ok) {
          setErrorMessage(result.message);
          setStatus("error");
          return false;
        }
        savedContentRef.current = nextContent;
        setSavedContent(nextContent);
        setStatus(contentRef.current === nextContent ? "saved" : "saving");
        setErrorMessage(null);
      } catch (error) {
        if (activePathRef.current === savingPath && workspaceRootRef.current === savingWorkspace) {
          setErrorMessage(messageOf(error));
          setStatus("error");
        }
        return false;
      } finally {
        saveInFlightRef.current = false;
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
      const nextState = getWriteCompletionAcceptState(content, completion);
      contentRef.current = nextState.content;
      setContent(nextState.content);
      setCompletion(nextState.completion);
      return;
    }
    if (event.key === "Escape" && completion) {
      event.preventDefault();
      setCompletion("");
    }
  }

  async function sendAssistantPrompt(): Promise<void> {
    if (!onSendAssistantPrompt || assistantSending || assistantBusy) return;
    const payload = buildWriteAssistantPrompt({
      prompt: assistantDraft,
      activePath,
      content,
      savedContent,
    });
    if (!payload) return;

    setAssistantSending(true);
    try {
      const sent = await onSendAssistantPrompt(payload);
      if (sent) setAssistantDraft("");
    } catch (error) {
      setErrorMessage(messageOf(error));
      setStatus("error");
    } finally {
      setAssistantSending(false);
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
    <div className="ds-write-workspace">
      <aside
        className="ds-write-sidebar"
        style={{
          width: state.leftSidebarWidth,
          flex: `0 0 ${state.leftSidebarWidth}px`,
        }}
      >
        <div className="ds-write-route-actions">
          <button
            type="button"
            className="ds-pill"
            onClick={() => void navigateFromWrite("code")}
          >
            {t("routes.code")}
          </button>
          <button
            type="button"
            className="ds-pill"
            onClick={() => void navigateFromWrite("settings")}
          >
            {t("common.settings")}
          </button>
        </div>
        <div className="ds-write-sidebar-actions">
          <button
            type="button"
            className="ds-pill"
            onClick={() => void loadList(undefined, search, { saveBeforeLoad: true })}
          >
            {t("write.openWorkspace")}
          </button>
          {state.workspaceRoot ? (
            <button
              type="button"
              className="ds-pill"
              onClick={() => void loadList(state.workspaceRoot, search, { saveBeforeLoad: true })}
            >
              {t("write.refresh")}
            </button>
          ) : null}
        </div>
        {state.workspaceRoot ? (
          <div
            className="ds-sidebar-workspace ds-write-workspace-label"
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
                clearSearchDebounceTimer();
                searchDebounceTimerRef.current = window.setTimeout(() => {
                  searchDebounceTimerRef.current = null;
                  void loadList(state.workspaceRoot, nextSearch, { saveBeforeLoad: false });
                }, WRITE_SEARCH_DEBOUNCE_MS);
              }
            }}
            placeholder={t("write.searchPlaceholder")}
            aria-label={t("write.searchPlaceholder")}
          />
          {search ? (
            <button
              type="button"
              className="ds-write-search-clear"
              onClick={handleClearSearch}
              aria-label={t("write.clearSearch")}
              title={t("write.clearSearch")}
            >
              {WRITE_SEARCH_CLEAR_BUTTON_TEXT}
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
              aria-current={file.path === activePath ? "page" : undefined}
              title={`${file.path} · ${formatWriteFileMeta(file)}`}
            >
              <span>{file.path}</span>
              <small>{formatWriteFileMeta(file)}</small>
            </button>
          ))}
        </div>
      </aside>
      <div className="ds-write-main">
        <section className="ds-write-editor">
          <div className="ds-write-editor-frame">
            <textarea
              value={content}
              onChange={(event) => {
                const nextState = getWriteDocumentEditState(event.target.value);
                contentRef.current = nextState.content;
                setContent(nextState.content);
                setCompletion(nextState.completion);
              }}
              onKeyDown={handleEditorKeyDown}
              placeholder={t("write.editorPlaceholder")}
              aria-label={t("write.editorPlaceholder")}
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
              type="button"
              className="ds-pill is-accent ds-write-save-button"
              onClick={() => void save()}
              disabled={saveDisabled}
            >
              {content !== savedContent ? t("write.save") : t("write.saved")}
            </button>
          </div>
        </section>
        <aside className="ds-write-assistant">
          <div className="ds-write-assistant-header">
            <div>
              <strong>{t("write.assistantTitle")}</strong>
              <span>
                {activePath
                  ? t("write.assistantCurrentFile", { path: activePath })
                  : t("write.assistantNoFile")}
              </span>
            </div>
            {assistantBusy ? <span className="ds-shiny-text">{t("chat.running")}</span> : null}
          </div>
          <div ref={assistantMessagesRef} className="ds-write-assistant-messages">
            {assistantItems.length > 0 ? (
              assistantItems.map((item) => (
                <ChatBlock
                  key={item.id}
                  item={item}
                  {...(item.turnId === state.activeTurnId ? { isLive: true } : {})}
                />
              ))
            ) : (
              <div className="ds-write-assistant-empty">{t("write.assistantEmpty")}</div>
            )}
          </div>
          <form
            className="ds-write-assistant-form"
            onSubmit={(event) => {
              event.preventDefault();
              void sendAssistantPrompt();
            }}
          >
            <textarea
              value={assistantDraft}
              onChange={(event) => setAssistantDraft(event.target.value)}
              placeholder={t("write.assistantPlaceholder")}
              aria-label={t("write.assistantPlaceholder")}
            />
            <div className="ds-write-assistant-actions">
              {assistantBusy && onInterruptAssistant ? (
                <button
                  type="button"
                  className="ds-pill"
                  onClick={onInterruptAssistant}
                >
                  {t("composer.interrupt")}
                </button>
              ) : null}
              <button
                type="submit"
                className="ds-pill is-accent"
                disabled={assistantSubmitDisabled}
              >
                {assistantSending ? t("write.assistantSending") : t("write.assistantSend")}
              </button>
            </div>
          </form>
        </aside>
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

export interface WriteDirtyDocumentInput {
  activePath: string | null;
  workspaceRoot: string;
  content: string;
  savedContent: string;
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

export function shouldSaveWriteFileBeforeSwitch(input: WriteDirtyDocumentInput): boolean {
  return Boolean(input.activePath && input.workspaceRoot && input.content !== input.savedContent);
}

export function shouldWarnBeforeLeavingWriteDocument(input: WriteDirtyDocumentInput): boolean {
  return shouldSaveWriteFileBeforeSwitch(input);
}

export function shouldApplyWriteOpenResult(input: {
  requestId: number;
  latestRequestId: number;
  requestedWorkspace: string;
  currentWorkspace: string;
  requestedPath: string;
  returnedPath?: string;
}): boolean {
  return (
    input.requestId === input.latestRequestId &&
    input.requestedWorkspace === input.currentWorkspace &&
    (input.returnedPath === undefined || input.returnedPath === input.requestedPath)
  );
}

export async function shouldUseSelectedWriteWorkspace(
  workspace: string,
  onWorkspaceSelected?: (workspace: string) => boolean | void | Promise<boolean | void>,
): Promise<boolean> {
  return (await onWorkspaceSelected?.(workspace)) !== false;
}

export function getWriteWorkspaceSwitchState(): {
  files: WriteFileEntry[];
  activePath: null;
  content: string;
  savedContent: string;
  completion: string;
} {
  return {
    files: [],
    activePath: null,
    content: "",
    savedContent: "",
    completion: "",
  };
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

export interface WriteDocumentStateUpdate {
  content: string;
  completion: string;
}

export function getWriteDocumentEditState(nextContent: string): WriteDocumentStateUpdate {
  return {
    content: nextContent,
    completion: "",
  };
}

export function getWriteCompletionAcceptState(
  content: string,
  completion: string,
): WriteDocumentStateUpdate {
  return {
    content: `${content}${completion}`,
    completion: "",
  };
}

export interface WriteAssistantPromptInput {
  prompt: string;
  activePath: string | null;
  content: string;
  savedContent: string;
}

export function buildWriteAssistantPrompt(
  input: WriteAssistantPromptInput,
): WriteAssistantPromptPayload | null {
  const prompt = input.prompt.trim();
  if (!prompt) return null;

  const currentFile = input.activePath ?? "none";
  const saveState = input.content === input.savedContent ? "saved" : "unsaved changes";
  return {
    text: [
      "Write workbench request:",
      prompt,
      "",
      "Context:",
      `- Current Markdown file: ${currentFile}`,
      `- Current file save state: ${saveState}`,
      "",
      "Respond with writing guidance or draft text. Do not claim that you changed files directly.",
    ].join("\n"),
    displayText: prompt,
    threadTitle: prompt,
  };
}

export function canSubmitWriteAssistantPrompt(input: {
  prompt: string;
  workspaceRoot: string;
  sending: boolean;
}): boolean {
  return Boolean(input.prompt.trim() && input.workspaceRoot.trim() && !input.sending);
}

export function getWriteAssistantVisibleItems(
  items: readonly Item[],
  limit = 12,
): Item[] {
  return items
    .filter((item) =>
      item.kind === "user" ||
      item.kind === "assistant" ||
      item.kind === "system"
    )
    .slice(-limit);
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString();
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 102.4) / 10} KB`;
  return `${Math.round(value / 1024 / 102.4) / 10} MB`;
}

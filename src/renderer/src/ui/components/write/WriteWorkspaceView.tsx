import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench, type WorkbenchRoute } from "../../store/WorkbenchContext";
import { type FloatingComposerRequestPayload } from "../composer";
import type { Item, WriteFileEntry } from "../../../../../shared/agent-contracts";
import {
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  LEFT_SIDEBAR_MAX_WIDTH,
  LEFT_SIDEBAR_MIN_WIDTH,
} from "../../preferences";
import type { ApprovalPendingDecision } from "../chat/ChatBlock";
import { WriteAssistantPanel } from "./WriteAssistantPanel";
import {
  WriteEditorPanel,
  type WriteEditorSelectionState,
  type WriteStatus,
} from "./WriteEditorPanel";

const AUTOSAVE_DELAY_MS = 800;
const COMPLETION_DELAY_MS = 650;
const WRITE_SEARCH_DEBOUNCE_MS = 250;
const COMPLETION_MIN_TRAILING_CHARS = 10;
const WRITE_SIDEBAR_KEYBOARD_STEP = 16;
export const WRITE_ASSISTANT_CONTEXT_MAX_CHARS = 1200;
export const WRITE_ASSISTANT_NEARBY_CONTEXT_RADIUS = 520;
export const WRITE_SEARCH_CLEAR_BUTTON_TEXT = "x";

export interface WriteAssistantPromptPayload extends FloatingComposerRequestPayload {
  text: string;
  displayText: string;
  threadTitle: string;
}

export interface WriteWorkspaceViewProps {
  onApprove?: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
  pendingApprovalResponses?: Record<string, ApprovalPendingDecision>;
  onWorkspaceSelected?: (workspace: string) => boolean | void | Promise<boolean | void>;
  onSendAssistantPrompt?: (payload: WriteAssistantPromptPayload) => Promise<boolean>;
  onInterruptAssistant?: () => void;
  assistantBusy?: boolean;
}

export function WriteWorkspaceView({
  onApprove,
  pendingApprovalResponses = {},
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
  const [status, setStatus] = useState<WriteStatus>("idle");
  const [listLoading, setListLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [editorSelection, setEditorSelection] = useState<WriteEditorSelectionState>({
    selectionStart: 0,
    selectionEnd: 0,
  });
  const [sidebarDragging, setSidebarDragging] = useState(false);
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

  useEffect(() => {
    activePathRef.current = activePath;
    workspaceRootRef.current = state.workspaceRoot;
    contentRef.current = content;
    savedContentRef.current = savedContent;
  }, [activePath, content, savedContent, state.workspaceRoot]);

  const assistantItems = getWriteAssistantVisibleItems(state.items);

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
    clearSearchDebounceTimer();
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
      setEditorSelection({ selectionStart: 0, selectionEnd: 0 });
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
    try {
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
        setEditorSelection({ selectionStart: 0, selectionEnd: 0 });
        setStatus("idle");
        setErrorMessage(null);
      } else {
        setErrorMessage(result.message);
        setStatus("error");
      }
    } catch (error) {
      if (requestId === openFileRequestId.current && workspace === workspaceRootRef.current) {
        setErrorMessage(messageOf(error));
        setStatus("error");
      }
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
    const completionContext = getWriteCompletionRequestContext({
      content,
      selection: editorSelection,
    });
    if (!shouldRequestWriteCompletion({
      activePath,
      workspaceRoot: state.workspaceRoot,
      prefix: completionContext.prefix,
    })) {
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
  }, [activePath, content, editorSelection, state.workspaceRoot]);

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
    const completionContext = getWriteCompletionRequestContext({
      content,
      selection: editorSelection,
    });
    if (!shouldRequestWriteCompletion({
      activePath,
      workspaceRoot: state.workspaceRoot,
      prefix: completionContext.prefix,
    })) {
      if (requestId === completionRequestId.current) setCompletion("");
      return;
    }
    try {
      const result = await window.agentApi.write.complete({
        workspace: state.workspaceRoot,
        path: activePath,
        prefix: completionContext.prefix,
        suffix: completionContext.suffix,
      });
      if (requestId !== completionRequestId.current) return;
      if (result.ok) {
        setCompletion(result.value.score > 0 ? result.value.completion : "");
        return;
      }
      setCompletion("");
      setErrorMessage(result.message);
      setStatus("error");
    } catch (error) {
      if (requestId !== completionRequestId.current) return;
      setCompletion("");
      setErrorMessage(messageOf(error));
      setStatus("error");
    }
  }

  function handleEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Tab" && completion) {
      event.preventDefault();
      const normalizedSelection = normalizeWriteEditorSelection(editorSelection, content.length);
      const nextState = getWriteCompletionAcceptState(content, completion, editorSelection);
      const nextCaret = normalizedSelection.selectionStart + completion.length;
      contentRef.current = nextState.content;
      setContent(nextState.content);
      setCompletion(nextState.completion);
      setEditorSelection({ selectionStart: nextCaret, selectionEnd: nextCaret });
      return;
    }
    if (event.key === "Escape" && completion) {
      event.preventDefault();
      setCompletion("");
    }
  }

  function handleEditorContentChange(
    nextContent: string,
    nextSelection?: WriteEditorSelectionState,
  ): void {
    const nextState = getWriteDocumentEditState(nextContent);
    contentRef.current = nextState.content;
    setContent(nextState.content);
    setCompletion(nextState.completion);
    if (nextSelection) setEditorSelection(nextSelection);
  }

  async function handleWriteComposerRequest(
    composerPayload: FloatingComposerRequestPayload,
  ): Promise<boolean> {
    if (!onSendAssistantPrompt || assistantBusy) return false;
    if (!state.workspaceRoot.trim()) return false;
    const payload = buildWriteAssistantPrompt({
      prompt: composerPayload.text,
      activePath,
      content,
      savedContent,
      selection: editorSelection,
    });
    if (!payload) return false;

    try {
      return await onSendAssistantPrompt(payload);
    } catch (error) {
      setErrorMessage(messageOf(error));
      setStatus("error");
      return false;
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
              title={`${file.path} | ${formatWriteFileMeta(file)}`}
            >
              <span>{file.path}</span>
              <small>{formatWriteFileMeta(file)}</small>
            </button>
          ))}
        </div>
      </aside>
      <div
        className={getWriteSidebarDividerClassName(sidebarDragging)}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("common.resizeLeftSidebar")}
        aria-valuemin={LEFT_SIDEBAR_MIN_WIDTH}
        aria-valuemax={LEFT_SIDEBAR_MAX_WIDTH}
        aria-valuenow={state.leftSidebarWidth}
        tabIndex={0}
        onKeyDown={(event) => {
          const next = getNextWriteSidebarWidth(
            state.leftSidebarWidth,
            event.key,
            WRITE_SIDEBAR_KEYBOARD_STEP,
          );
          if (next === state.leftSidebarWidth) return;
          event.preventDefault();
          actions.setLeftSidebarWidth(next);
        }}
        onDoubleClick={() => actions.setLeftSidebarWidth(LEFT_SIDEBAR_DEFAULT_WIDTH)}
        onPointerDown={(event) => {
          const startX = event.clientX;
          const startWidth = state.leftSidebarWidth;
          const target = event.currentTarget;
          setSidebarDragging(true);
          target.setPointerCapture(event.pointerId);
          const onMove = (ev: PointerEvent): void => {
            const dx = ev.clientX - startX;
            actions.setLeftSidebarWidth(clampWriteSidebarWidth(startWidth + dx));
          };
          const clearDragListeners = (): void => {
            setSidebarDragging(false);
            target.removeEventListener("pointermove", onMove);
            target.removeEventListener("pointerup", clearDragListeners);
            target.removeEventListener("pointercancel", clearDragListeners);
          };
          target.addEventListener("pointermove", onMove);
          target.addEventListener("pointerup", clearDragListeners);
          target.addEventListener("pointercancel", clearDragListeners);
        }}
      />
      <div className="ds-write-main">
        <WriteEditorPanel
          content={content}
          savedContent={savedContent}
          completion={completion}
          selectionStart={editorSelection.selectionStart}
          selectionEnd={editorSelection.selectionEnd}
          status={status}
          errorMessage={errorMessage}
          activePath={activePath}
          saveDisabled={saveDisabled}
          onContentChange={handleEditorContentChange}
          onSelectionChange={setEditorSelection}
          onEditorKeyDown={handleEditorKeyDown}
          onSave={() => void save()}
        />
        <WriteAssistantPanel
          activePath={activePath}
          activeTurnId={state.activeTurnId}
          assistantBusy={assistantBusy}
          assistantItems={assistantItems}
          composerDisabled={!state.workspaceRoot || !onSendAssistantPrompt}
          onRequestSend={handleWriteComposerRequest}
          onInterrupt={onInterruptAssistant ?? (() => undefined)}
          onApprove={onApprove}
          pendingApprovalResponses={pendingApprovalResponses}
        />
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
  return `${formatBytes(file.size)} | ${formatDate(file.modifiedAt)}`;
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
  selection: WriteEditorSelectionState = {
    selectionStart: content.length,
    selectionEnd: content.length,
  },
): WriteDocumentStateUpdate {
  const normalized = normalizeWriteEditorSelection(selection, content.length);
  return {
    content: `${content.slice(0, normalized.selectionStart)}${completion}${content.slice(
      normalized.selectionEnd,
    )}`,
    completion: "",
  };
}

export function getWriteCompletionRequestContext({
  content,
  selection,
}: {
  content: string;
  selection: WriteEditorSelectionState;
}): { prefix: string; suffix: string } {
  const normalized = normalizeWriteEditorSelection(selection, content.length);
  return {
    prefix: content.slice(0, normalized.selectionStart),
    suffix: content.slice(normalized.selectionEnd),
  };
}

export function shouldRequestWriteCompletion({
  activePath,
  workspaceRoot,
  prefix,
  minTrailingChars = COMPLETION_MIN_TRAILING_CHARS,
}: {
  activePath: string | null;
  workspaceRoot: string;
  prefix: string;
  minTrailingChars?: number;
}): boolean {
  return Boolean(activePath && workspaceRoot && prefix.trimEnd().length >= minTrailingChars);
}

export interface WriteAssistantPromptInput {
  prompt: string;
  activePath: string | null;
  content: string;
  savedContent: string;
  selection?: WriteEditorSelectionState;
}

export function buildWriteAssistantPrompt(
  input: WriteAssistantPromptInput,
): WriteAssistantPromptPayload | null {
  const prompt = input.prompt.trim();
  if (!prompt) return null;

  const currentFile = input.activePath ?? "none";
  const saveState = input.content === input.savedContent ? "saved" : "unsaved changes";
  const localContext = getWriteAssistantLocalContext({
    content: input.content,
    selection: input.selection ?? {
      selectionStart: input.content.length,
      selectionEnd: input.content.length,
    },
  });
  const contextLines = [
    `- Current Markdown file: ${currentFile}`,
    `- Current file save state: ${saveState}`,
  ];
  if (localContext) {
    contextLines.push(
      `- ${localContext.label}:`,
      localContext.text,
    );
  }
  return {
    text: [
      "Write workbench request:",
      prompt,
      "",
      "Context:",
      ...contextLines,
      "",
      "Respond with writing guidance or draft text. Do not claim that you changed files directly.",
    ].join("\n"),
    displayText: prompt,
    threadTitle: prompt,
    attachmentIds: [],
    mode: "agent",
    goalMode: false,
  };
}

export function getWriteAssistantVisibleItems(
  items: readonly Item[],
  limit = 80,
): Item[] {
  if (items.length <= limit) return [...items];
  const limitedStartIndex = Math.max(0, items.length - limit);
  const firstLimitedTurnId = items[limitedStartIndex]?.turnId;
  if (!firstLimitedTurnId) return items.slice(limitedStartIndex);
  let startIndex = limitedStartIndex;
  while (startIndex > 0 && items[startIndex - 1]?.turnId === firstLimitedTurnId) {
    startIndex -= 1;
  }
  return items.slice(startIndex);
}

export interface WriteAssistantLocalContext {
  label: "Selected text" | "Nearby text";
  text: string;
}

export function getWriteAssistantLocalContext({
  content,
  selection,
  maxChars = WRITE_ASSISTANT_CONTEXT_MAX_CHARS,
  nearbyRadius = WRITE_ASSISTANT_NEARBY_CONTEXT_RADIUS,
}: {
  content: string;
  selection: WriteEditorSelectionState;
  maxChars?: number;
  nearbyRadius?: number;
}): WriteAssistantLocalContext | null {
  const normalized = normalizeWriteEditorSelection(selection, content.length);
  const selected = content
    .slice(normalized.selectionStart, normalized.selectionEnd)
    .trim();
  if (selected) {
    return {
      label: "Selected text",
      text: truncateWriteAssistantContext(selected, maxChars),
    };
  }

  const nearby = getWriteNearbyContext({
    content,
    caret: normalized.selectionStart,
    radius: nearbyRadius,
    maxChars,
  }).trim();
  return nearby
    ? {
        label: "Nearby text",
        text: nearby,
      }
    : null;
}

export function getWriteNearbyContext({
  content,
  caret,
  radius = WRITE_ASSISTANT_NEARBY_CONTEXT_RADIUS,
  maxChars = WRITE_ASSISTANT_CONTEXT_MAX_CHARS,
}: {
  content: string;
  caret: number;
  radius?: number;
  maxChars?: number;
}): string {
  if (!content.trim()) return "";
  const normalizedCaret = Math.min(Math.max(0, caret), content.length);
  const start = Math.max(0, normalizedCaret - Math.max(0, radius));
  const end = Math.min(content.length, normalizedCaret + Math.max(0, radius));
  if (start === 0 && end === content.length) return "";
  const prefix = start > 0 ? "[...]\n" : "";
  const suffix = end < content.length ? "\n[...]" : "";
  return truncateWriteAssistantContext(`${prefix}${content.slice(start, end)}${suffix}`, maxChars);
}

export function truncateWriteAssistantContext(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 12) return text.slice(0, Math.max(0, maxChars));
  return `${text.slice(0, maxChars - 8)}\n[...]`;
}

export function normalizeWriteEditorSelection(
  selection: WriteEditorSelectionState,
  contentLength: number,
): WriteEditorSelectionState {
  const start = Math.min(Math.max(0, selection.selectionStart), contentLength);
  const end = Math.min(Math.max(0, selection.selectionEnd), contentLength);
  return {
    selectionStart: Math.min(start, end),
    selectionEnd: Math.max(start, end),
  };
}

export function clampWriteSidebarWidth(width: number): number {
  return Math.min(LEFT_SIDEBAR_MAX_WIDTH, Math.max(LEFT_SIDEBAR_MIN_WIDTH, width));
}

export function getNextWriteSidebarWidth(
  currentWidth: number,
  key: string,
  step = WRITE_SIDEBAR_KEYBOARD_STEP,
): number {
  if (key === "ArrowLeft") return clampWriteSidebarWidth(currentWidth - step);
  if (key === "ArrowRight") return clampWriteSidebarWidth(currentWidth + step);
  if (key === "Home") return LEFT_SIDEBAR_MIN_WIDTH;
  if (key === "End") return LEFT_SIDEBAR_MAX_WIDTH;
  return currentWidth;
}

export function getWriteSidebarDividerClassName(isDragging: boolean): string {
  return isDragging
    ? "ds-workbench-divider ds-write-sidebar-divider is-dragging"
    : "ds-workbench-divider ds-write-sidebar-divider";
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString();
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 102.4) / 10} KB`;
  return `${Math.round(value / 1024 / 102.4) / 10} MB`;
}

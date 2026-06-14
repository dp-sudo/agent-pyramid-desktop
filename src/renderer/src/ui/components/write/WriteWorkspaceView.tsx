import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench, type WorkbenchRoute } from "../../store/WorkbenchContext";
import { type FloatingComposerRequestPayload } from "../composer";
import type {
  ThreadSummary,
  WriteFileEntry,
} from "../../../../../shared/agent-contracts";
import {
  LEFT_SIDEBAR_MAX_WIDTH,
  LEFT_SIDEBAR_MIN_WIDTH,
} from "../../preferences";
import {
  clampLeftSidebarWidth,
  getNextLeftSidebarWidth,
  getResetLeftSidebarWidth,
  getSidebarDividerClassName,
} from "../../sidebar-resize-model";
import type { ApprovalPendingDecision } from "../chat/ChatBlock";
import { ThreadSessionList } from "../sidebar/Sidebar";
import { WriteAssistantPanel } from "./WriteAssistantPanel";
import { WriteEditorPanel } from "./WriteEditorPanel";
import {
  COMPLETION_DELAY_MS,
  WRITE_SEARCH_DEBOUNCE_MS,
} from "./write-constants";
import {
  buildWriteAssistantPrompt,
  formatWriteFileMeta,
  getNextWriteDocumentPath,
  getWriteAssistantPromptText,
  getWriteAssistantVisibleItems,
  getWriteClearedDocumentState,
  getWriteCompletionAcceptState,
  getWriteCompletionRequestContext,
  getWriteContextMenuPosition,
  getWriteDocumentEditState,
  getWriteDocumentPathValidationError,
  getWriteListState,
  getWriteOpenDocumentState,
  getWriteWorkspaceSwitchState,
  isWriteEditorSelectionEqual,
  normalizeWriteDocumentPathInput,
  normalizeWriteEditorSelection,
  shouldApplyWriteCompletionResult,
  shouldApplyWriteOpenResult,
  shouldDisableWriteSave,
  shouldRequestWriteCompletion,
  shouldSaveWriteFileBeforeDocumentDelete,
  shouldSaveWriteFileBeforeSwitch,
  shouldUseSelectedWriteWorkspace,
  shouldWarnBeforeLeavingWriteDocument,
  WRITE_SEARCH_CLEAR_BUTTON_TEXT,
  type WriteAssistantPromptPayload,
  type WriteDocumentViewState,
  type WriteEditorSelectionState,
  type WriteStatus,
} from "./write-workspace-model";

const AUTOSAVE_DELAY_MS = 800;
export {
  WRITE_ASSISTANT_CONTEXT_MAX_CHARS,
  WRITE_ASSISTANT_NEARBY_CONTEXT_RADIUS,
} from "./write-constants";

export interface WriteWorkspaceViewProps {
  onApprove?: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
  pendingApprovalResponses?: Record<string, ApprovalPendingDecision>;
  onWorkspaceSelected?: (workspace: string) => boolean | void | Promise<boolean | void>;
  onSendAssistantPrompt?: (payload: WriteAssistantPromptPayload) => Promise<boolean>;
  onInterruptAssistant?: () => void;
  assistantBusy?: boolean;
  writeThreads?: ThreadSummary[];
  onSelectWriteThread?: (id: string) => void | Promise<void>;
  onNewWriteThread?: () => void | Promise<void>;
  onDeleteWriteThread?: (id: string) => void | Promise<void>;
  onArchiveWriteThread?: (id: string) => void | Promise<void>;
  onRestoreWriteThread?: (id: string) => void | Promise<void>;
  showArchivedThreads?: boolean;
  onToggleArchivedThreads?: () => void;
}

type WriteDocumentAction =
  | { kind: "create"; path: string }
  | { kind: "rename"; path: string; newPath: string }
  | { kind: "delete"; path: string }
  | null;

interface WriteDocumentContextMenu {
  path: string | null;
  x: number;
  y: number;
}

export function WriteWorkspaceView({
  onApprove,
  pendingApprovalResponses = {},
  onWorkspaceSelected,
  onSendAssistantPrompt,
  onInterruptAssistant,
  assistantBusy = false,
  writeThreads = [],
  onSelectWriteThread,
  onNewWriteThread,
  onDeleteWriteThread,
  onArchiveWriteThread,
  onRestoreWriteThread,
  showArchivedThreads = false,
  onToggleArchivedThreads,
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
  const [creatingDocument, setCreatingDocument] = useState(false);
  const [createPath, setCreatePath] = useState("untitled.md");
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renamePath, setRenamePath] = useState("");
  const [deleteConfirmPath, setDeleteConfirmPath] = useState<string | null>(null);
  const [documentAction, setDocumentAction] = useState<WriteDocumentAction>(null);
  const [contextMenu, setContextMenu] = useState<WriteDocumentContextMenu | null>(null);
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
  const listedWorkspaceRef = useRef("");

  useEffect(() => {
    activePathRef.current = activePath;
    workspaceRootRef.current = state.workspaceRoot;
    contentRef.current = content;
    savedContentRef.current = savedContent;
  }, [activePath, content, savedContent, state.workspaceRoot]);

  const assistantItems = getWriteAssistantVisibleItems(state.items);

  function invalidateCompletionRequests(): void {
    completionRequestId.current += 1;
  }

  function applyWriteDocumentState(
    nextState: WriteDocumentViewState,
    options: { invalidateOpenRequests?: boolean } = {},
  ): void {
    if (options.invalidateOpenRequests) openFileRequestId.current += 1;
    invalidateCompletionRequests();
    activePathRef.current = nextState.activePath;
    contentRef.current = nextState.content;
    savedContentRef.current = nextState.savedContent;
    setActivePath(nextState.activePath);
    setContent(nextState.content);
    setSavedContent(nextState.savedContent);
    setCompletion(nextState.completion);
    setEditorSelection(nextState.selection);
  }

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
    const switchingWorkspace =
      workspace !== workspaceRootRef.current ||
      workspace !== listedWorkspaceRef.current;
    if (switchingWorkspace) {
      // A workspace boundary invalidates all file-relative state even if listing fails.
      const clearedState = getWriteWorkspaceSwitchState();
      setFiles(clearedState.files);
      applyWriteDocumentState(clearedState, { invalidateOpenRequests: true });
    }
    listedWorkspaceRef.current = workspace;
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
        applyWriteDocumentState(getWriteOpenDocumentState(path, result.value.content));
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

  function setOpenDocument(path: string, nextContent: string): void {
    applyWriteDocumentState(getWriteOpenDocumentState(path, nextContent), {
      invalidateOpenRequests: true,
    });
    setStatus("idle");
    setErrorMessage(null);
  }

  function clearOpenDocument(path: string): void {
    if (activePathRef.current !== path) return;
    applyWriteDocumentState(getWriteClearedDocumentState(), {
      invalidateOpenRequests: true,
    });
  }

  function beginCreateDocument(): void {
    if (!state.workspaceRoot) {
      setErrorMessage(t("write.workspaceRequired"));
      setStatus("error");
      return;
    }
    setCreatePath(getNextWriteDocumentPath(files));
    setCreatingDocument(true);
    setRenamingPath(null);
    setDeleteConfirmPath(null);
    setContextMenu(null);
  }

  function cancelCreateDocument(): void {
    setCreatingDocument(false);
    setCreatePath(getNextWriteDocumentPath(files));
  }

  async function submitCreateDocument(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const workspace = state.workspaceRoot;
    const path = normalizeWriteDocumentPathInput(createPath);
    if (!workspace) {
      setErrorMessage(t("write.workspaceRequired"));
      setStatus("error");
      return;
    }
    if (getWriteDocumentPathValidationError(path)) {
      setErrorMessage(t("write.invalidDocumentPath"));
      setStatus("error");
      return;
    }
    if (!(await saveCurrentFileBeforeSwitch())) return;
    setDocumentAction({ kind: "create", path });
    setStatus("loading");
    try {
      const result = await window.agentApi.write.create({ workspace, path, content: "" });
      if (!result.ok) {
        setErrorMessage(result.message);
        setStatus("error");
        return;
      }
      setCreatingDocument(false);
      setSearch("");
      setOpenDocument(result.value.path, result.value.content);
      await loadList(workspace, "", { saveBeforeLoad: false });
    } catch (error) {
      setErrorMessage(messageOf(error));
      setStatus("error");
    } finally {
      setDocumentAction(null);
    }
  }

  function beginRenameDocument(path: string): void {
    setRenamingPath(path);
    setRenamePath(path);
    setCreatingDocument(false);
    setDeleteConfirmPath(null);
    setContextMenu(null);
  }

  function cancelRenameDocument(): void {
    setRenamingPath(null);
    setRenamePath("");
  }

  async function submitRenameDocument(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const workspace = state.workspaceRoot;
    const path = renamingPath;
    const newPath = normalizeWriteDocumentPathInput(renamePath);
    if (!workspace) {
      setErrorMessage(t("write.workspaceRequired"));
      setStatus("error");
      return;
    }
    if (!path || getWriteDocumentPathValidationError(newPath)) {
      setErrorMessage(t("write.invalidDocumentPath"));
      setStatus("error");
      return;
    }
    if (path === newPath) {
      setErrorMessage(t("write.renameSamePath"));
      setStatus("error");
      return;
    }
    if (!(await saveCurrentFileBeforeSwitch())) return;
    setDocumentAction({ kind: "rename", path, newPath });
    setStatus("loading");
    try {
      const result = await window.agentApi.write.rename({ workspace, path, newPath });
      if (!result.ok) {
        setErrorMessage(result.message);
        setStatus("error");
        return;
      }
      setRenamingPath(null);
      setSearch("");
      if (activePathRef.current === path) {
        setOpenDocument(result.value.newPath, contentRef.current);
      }
      await loadList(workspace, "", { saveBeforeLoad: false });
    } catch (error) {
      setErrorMessage(messageOf(error));
      setStatus("error");
    } finally {
      setDocumentAction(null);
    }
  }

  function requestDeleteDocument(path: string): void {
    setDeleteConfirmPath(path);
    setCreatingDocument(false);
    setRenamingPath(null);
    setContextMenu(null);
  }

  function cancelDeleteDocument(): void {
    setDeleteConfirmPath(null);
  }

  async function confirmDeleteDocument(path: string): Promise<void> {
    const workspace = state.workspaceRoot;
    if (!workspace) {
      setErrorMessage(t("write.workspaceRequired"));
      setStatus("error");
      return;
    }
    if (!(await saveCurrentFileBeforeDocumentDelete(path))) return;
    setDocumentAction({ kind: "delete", path });
    setStatus("loading");
    try {
      const result = await window.agentApi.write.delete({ workspace, path });
      if (!result.ok) {
        setErrorMessage(result.message);
        setStatus("error");
        return;
      }
      setDeleteConfirmPath(null);
      clearOpenDocument(path);
      await loadList(workspace, search, { saveBeforeLoad: false });
      setStatus("idle");
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(messageOf(error));
      setStatus("error");
    } finally {
      setDocumentAction(null);
    }
  }

  function openDocumentContextMenu(
    event: MouseEvent<HTMLElement>,
    path: string | null,
  ): void {
    if (!state.workspaceRoot) return;
    event.preventDefault();
    event.stopPropagation();
    const position = getWriteContextMenuPosition({
      clientX: event.clientX,
      clientY: event.clientY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    setContextMenu({
      path,
      x: position.x,
      y: position.y,
    });
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
    if (!state.workspaceRoot) {
      listedWorkspaceRef.current = "";
      const clearedState = getWriteWorkspaceSwitchState();
      setFiles(clearedState.files);
      applyWriteDocumentState(clearedState, { invalidateOpenRequests: true });
      return;
    }
    if (state.workspaceRoot === listedWorkspaceRef.current) return;
    void loadList(state.workspaceRoot, search, { saveBeforeLoad: false });
  }, [state.workspaceRoot]);

  useEffect(() => {
    if (!contextMenu) return undefined;

    function closeContextMenu(): void {
      setContextMenu(null);
    }

    function handleContextMenuKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") closeContextMenu();
    }

    window.addEventListener("pointerdown", closeContextMenu);
    window.addEventListener("keydown", handleContextMenuKeyDown);
    return () => {
      window.removeEventListener("pointerdown", closeContextMenu);
      window.removeEventListener("keydown", handleContextMenuKeyDown);
    };
  }, [contextMenu]);

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

  async function saveCurrentFileBeforeDocumentDelete(path: string): Promise<boolean> {
    if (shouldSaveWriteFileBeforeDocumentDelete({
      deletingPath: path,
      activePath: activePathRef.current,
      workspaceRoot: workspaceRootRef.current,
      content: contentRef.current,
      savedContent: savedContentRef.current,
    })) {
      return saveCurrentFileBeforeSwitch();
    }
    if (saveInFlightRef.current) {
      await savePromiseRef.current;
    }
    return true;
  }

  async function navigateFromWrite(
    route: Extract<WorkbenchRoute, "code" | "settings">,
  ): Promise<void> {
    if (!(await saveCurrentFileBeforeSwitch())) return;
    actions.setRoute(route);
  }

  async function runWriteSessionAction(action?: () => void | Promise<void>): Promise<void> {
    if (!action) return;
    if (!(await saveCurrentFileBeforeSwitch())) return;
    await action();
  }

  async function runWriteThreadAction(
    id: string,
    action?: (threadId: string) => void | Promise<void>,
  ): Promise<void> {
    await runWriteSessionAction(() => action?.(id));
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
    const requestedPath = activePath;
    const requestedWorkspace = state.workspaceRoot;
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
        workspace: requestedWorkspace,
        path: requestedPath,
        prefix: completionContext.prefix,
        suffix: completionContext.suffix,
      });
      if (!shouldApplyWriteCompletionResult({
        requestId,
        latestRequestId: completionRequestId.current,
        requestedWorkspace,
        currentWorkspace: workspaceRootRef.current,
        requestedPath,
        currentPath: activePathRef.current,
      })) {
        return;
      }
      if (result.ok) {
        setCompletion(result.value.score > 0 ? result.value.completion : "");
        return;
      }
      setCompletion("");
      setErrorMessage(result.message);
      setStatus("error");
    } catch (error) {
      if (!shouldApplyWriteCompletionResult({
        requestId,
        latestRequestId: completionRequestId.current,
        requestedWorkspace,
        currentWorkspace: workspaceRootRef.current,
        requestedPath,
        currentPath: activePathRef.current,
      })) {
        return;
      }
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
      invalidateCompletionRequests();
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
    invalidateCompletionRequests();
    contentRef.current = nextState.content;
    setContent(nextState.content);
    setCompletion(nextState.completion);
    if (nextSelection) setEditorSelection(nextSelection);
  }

  function handleEditorSelectionChange(nextSelection: WriteEditorSelectionState): void {
    if (isWriteEditorSelectionEqual(editorSelection, nextSelection)) return;
    invalidateCompletionRequests();
    setEditorSelection(nextSelection);
  }

  async function handleWriteComposerRequest(
    composerPayload: FloatingComposerRequestPayload,
  ): Promise<boolean> {
    if (!onSendAssistantPrompt || assistantBusy) return false;
    if (!state.workspaceRoot.trim()) return false;
    const promptText = getWriteAssistantPromptText(
      composerPayload.text,
      composerPayload.attachmentIds.length,
      t,
    );
    const payload = buildWriteAssistantPrompt({
      prompt: promptText,
      activePath,
      content,
      savedContent,
      selection: editorSelection,
      attachmentIds: composerPayload.attachmentIds,
      mode: composerPayload.mode,
      goalMode: composerPayload.goalMode,
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
  const documentActionRunning = documentAction !== null;

  return (
    <div className="ds-write-workspace">
      <aside
        className="ds-write-sidebar"
        style={{
          width: state.leftSidebarWidth,
          flex: `0 0 ${state.leftSidebarWidth}px`,
        }}
      >
        <div
          className="ds-write-route-actions"
          role="group"
          aria-label={t("routes.switchWorkbench")}
        >
          <button
            type="button"
            className="ds-pill"
            onClick={() => void navigateFromWrite("code")}
          >
            {t("routes.code")}
          </button>
          <button
            type="button"
            className="ds-pill is-active"
            aria-current="page"
          >
            {t("routes.write")}
          </button>
          <button
            type="button"
            className="ds-pill"
            onClick={() => void navigateFromWrite("settings")}
          >
            {t("common.settings")}
          </button>
        </div>
        <section className="ds-write-sidebar-section">
          <div className="ds-write-sidebar-section-header">
            <div>
              <strong>{t("write.workspaceTitle")}</strong>
              <span>{state.workspaceRoot || t("threads.noWorkspace")}</span>
            </div>
          </div>
          <div className="ds-write-sidebar-actions">
            <button
              type="button"
              className="ds-pill"
              onClick={() => void loadList(undefined, search, { saveBeforeLoad: true })}
            >
              {t("write.openWorkspace")}
            </button>
            <button
              type="button"
              className="ds-pill"
              disabled={!state.workspaceRoot}
              onClick={() => void loadList(state.workspaceRoot, search, { saveBeforeLoad: true })}
            >
              {t("write.refresh")}
            </button>
          </div>
          <div
            className="ds-sidebar-workspace ds-write-workspace-label"
            title={state.workspaceRoot || t("threads.noWorkspace")}
          >
            {state.workspaceRoot || t("threads.noWorkspace")}
          </div>
        </section>
        <section className="ds-write-sidebar-section ds-write-sessions-section">
          <div className="ds-write-sidebar-section-header">
            <div>
              <strong>{t("write.sessionsTitle")}</strong>
              <span>{t("write.sessionsCount", { count: writeThreads.length })}</span>
            </div>
            <button
              type="button"
              className="ds-pill is-accent"
              onClick={() => void runWriteSessionAction(onNewWriteThread)}
              disabled={!onNewWriteThread}
            >
              {t("threads.newChat")}
            </button>
          </div>
          <button
            type="button"
            className="ds-sidebar-archive-toggle ds-write-archive-toggle"
            onClick={onToggleArchivedThreads}
            disabled={!onToggleArchivedThreads}
          >
            {showArchivedThreads ? t("threads.hideArchived") : t("threads.showArchived")}
          </button>
          <ThreadSessionList
            threads={writeThreads}
            className="ds-write-session-list"
            onSelectThread={(id) => void runWriteThreadAction(id, onSelectWriteThread)}
            onDeleteThread={(id) => runWriteThreadAction(id, onDeleteWriteThread)}
            onArchiveThread={(id) => runWriteThreadAction(id, onArchiveWriteThread)}
            onRestoreThread={(id) => runWriteThreadAction(id, onRestoreWriteThread)}
          />
        </section>
        <section className="ds-write-sidebar-section ds-write-documents-section">
          <div className="ds-write-document-toolbar">
            <div>
              <strong>{t("write.documentsTitle")}</strong>
              <span>{t("write.documentsCount", { count: files.length })}</span>
            </div>
            <button
              type="button"
              className="ds-pill is-accent"
              onClick={beginCreateDocument}
              disabled={!state.workspaceRoot || documentActionRunning}
            >
              {t("write.newDocument")}
            </button>
          </div>
          {creatingDocument ? (
            <form className="ds-write-document-form" onSubmit={(event) => void submitCreateDocument(event)}>
              <input
                value={createPath}
                onChange={(event) => setCreatePath(event.target.value)}
                placeholder={t("write.documentPathPlaceholder")}
                aria-label={t("write.documentPathPlaceholder")}
                autoFocus
              />
              <div>
                <button
                  type="submit"
                  className="ds-pill is-accent"
                  disabled={documentActionRunning}
                >
                  {t("write.createDocument")}
                </button>
                <button
                  type="button"
                  className="ds-pill"
                  onClick={cancelCreateDocument}
                  disabled={documentActionRunning}
                >
                  {t("common.cancel")}
                </button>
              </div>
            </form>
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
          <div
            className="ds-write-document-list"
            onContextMenu={(event) => openDocumentContextMenu(event, null)}
          >
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
            {files.map((file) => {
              const isActive = file.path === activePath;
              const isRenaming = renamingPath === file.path;
              const isConfirmingDelete = deleteConfirmPath === file.path;
              const isBusy =
                (documentAction?.kind === "delete" && documentAction.path === file.path) ||
                (documentAction?.kind === "rename" && documentAction.path === file.path);
              return (
                <div
                  key={file.path}
                  className={`ds-write-file-row ${isActive ? "is-active" : ""} ${isConfirmingDelete ? "is-confirming-delete" : ""} ${isBusy ? "is-busy" : ""}`}
                  onContextMenu={(event) => openDocumentContextMenu(event, file.path)}
                  aria-busy={isBusy || undefined}
                >
                  {isRenaming ? (
                    <form
                      className="ds-write-document-form is-inline"
                      onSubmit={(event) => void submitRenameDocument(event)}
                    >
                      <input
                        value={renamePath}
                        onChange={(event) => setRenamePath(event.target.value)}
                        aria-label={t("write.renameDocument")}
                        autoFocus
                      />
                      <div>
                        <button
                          type="submit"
                          className="ds-pill is-accent"
                          disabled={documentActionRunning}
                        >
                          {t("write.saveName")}
                        </button>
                        <button
                          type="button"
                          className="ds-pill"
                          onClick={cancelRenameDocument}
                          disabled={documentActionRunning}
                        >
                          {t("common.cancel")}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="ds-write-file-row-main"
                        onClick={() => void openFile(file.path)}
                        aria-current={isActive ? "page" : undefined}
                        title={`${file.path} | ${formatWriteFileMeta(file)}`}
                      >
                        <span>{file.path}</span>
                        <small>{formatWriteFileMeta(file)}</small>
                      </button>
                      {isConfirmingDelete ? (
                        <div className="ds-write-file-delete-confirm">
                          <span>{t("write.deleteConfirmShort")}</span>
                          <button
                            type="button"
                            className="ds-write-file-action is-danger"
                            onClick={() => void confirmDeleteDocument(file.path)}
                            disabled={documentActionRunning}
                          >
                            {t("write.deleteConfirmAction")}
                          </button>
                          <button
                            type="button"
                            className="ds-write-file-action"
                            onClick={cancelDeleteDocument}
                            disabled={documentActionRunning}
                          >
                            {t("common.cancel")}
                          </button>
                        </div>
                      ) : (
                        <div className="ds-write-file-actions">
                          <button
                            type="button"
                            className="ds-write-file-action"
                            onClick={() => beginRenameDocument(file.path)}
                            disabled={documentActionRunning}
                            title={t("write.renameDocument")}
                            aria-label={t("write.renameDocument")}
                          >
                            {t("write.renameShort")}
                          </button>
                          <button
                            type="button"
                            className="ds-write-file-action"
                            onClick={() => requestDeleteDocument(file.path)}
                            disabled={documentActionRunning}
                            title={t("write.deleteDocument")}
                            aria-label={t("write.deleteDocument")}
                          >
                            {t("write.deleteShort")}
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </section>
        {contextMenu ? (
          <div
            className="ds-write-context-menu"
            role="menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={beginCreateDocument}
              disabled={documentActionRunning}
            >
              {t("write.newDocument")}
            </button>
            {contextMenu.path ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    if (contextMenu.path) beginRenameDocument(contextMenu.path);
                  }}
                  disabled={documentActionRunning}
                >
                  {t("write.renameDocument")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="is-danger"
                  onClick={() => {
                    if (contextMenu.path) requestDeleteDocument(contextMenu.path);
                  }}
                  disabled={documentActionRunning}
                >
                  {t("write.deleteDocument")}
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </aside>
      <div
        className={getSidebarDividerClassName(sidebarDragging, "ds-write-sidebar-divider")}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("common.resizeLeftSidebar")}
        aria-valuemin={LEFT_SIDEBAR_MIN_WIDTH}
        aria-valuemax={LEFT_SIDEBAR_MAX_WIDTH}
        aria-valuenow={state.leftSidebarWidth}
        tabIndex={0}
        onKeyDown={(event) => {
          const next = getNextLeftSidebarWidth(
            state.leftSidebarWidth,
            event.key,
          );
          if (next === state.leftSidebarWidth) return;
          event.preventDefault();
          actions.setLeftSidebarWidth(next);
        }}
        onDoubleClick={() => actions.setLeftSidebarWidth(getResetLeftSidebarWidth())}
        onPointerDown={(event) => {
          const startX = event.clientX;
          const startWidth = state.leftSidebarWidth;
          const target = event.currentTarget;
          setSidebarDragging(true);
          target.setPointerCapture(event.pointerId);
          const onMove = (ev: PointerEvent): void => {
            const dx = ev.clientX - startX;
            actions.setLeftSidebarWidth(clampLeftSidebarWidth(startWidth + dx));
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
          onSelectionChange={handleEditorSelectionChange}
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

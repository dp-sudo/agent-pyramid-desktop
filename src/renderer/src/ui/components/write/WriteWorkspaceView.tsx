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
  Item,
  ThreadSummary,
  WriteFileEntry,
} from "../../../../../shared/agent-contracts";
import {
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  LEFT_SIDEBAR_MAX_WIDTH,
  LEFT_SIDEBAR_MIN_WIDTH,
} from "../../preferences";
import { formatBytes } from "../../format";
import type { ApprovalPendingDecision } from "../chat/ChatBlock";
import { ThreadSessionList } from "../sidebar/Sidebar";
import { WriteAssistantPanel } from "./WriteAssistantPanel";
import {
  WriteEditorPanel,
  type WriteEditorSelectionState,
  type WriteStatus,
} from "./WriteEditorPanel";
import {
  COMPLETION_DELAY_MS,
  COMPLETION_MIN_TRAILING_CHARS,
  WRITE_ASSISTANT_CONTEXT_MAX_CHARS,
  WRITE_ASSISTANT_NEARBY_CONTEXT_RADIUS,
  WRITE_COMPLETION_PREFIX_MAX_CHARS,
  WRITE_COMPLETION_SUFFIX_MAX_CHARS,
  WRITE_SEARCH_DEBOUNCE_MS,
} from "./write-constants";
import { getTimelineItemTurnId, sortTimelineItems } from "../chat/timeline-model";

const AUTOSAVE_DELAY_MS = 800;
const WRITE_SIDEBAR_KEYBOARD_STEP = 16;
const WRITE_CONTEXT_MENU_WIDTH_PX = 176;
const WRITE_CONTEXT_MENU_HEIGHT_PX = 124;
const WRITE_CONTEXT_MENU_VIEWPORT_MARGIN_PX = 8;
const WRITE_MARKDOWN_EXTENSIONS = [".md", ".mdx", ".markdown"] as const;
export {
  WRITE_ASSISTANT_CONTEXT_MAX_CHARS,
  WRITE_ASSISTANT_NEARBY_CONTEXT_RADIUS,
} from "./write-constants";
export const WRITE_SEARCH_CLEAR_BUTTON_TEXT = "x";

export type WriteDocumentPathValidationError =
  | "empty"
  | "directory"
  | "empty-segment"
  | "dot-segment"
  | "drive-root"
  | "extension"
  | "filename";

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

export interface WriteDocumentViewState {
  activePath: string | null;
  content: string;
  savedContent: string;
  completion: string;
  selection: WriteEditorSelectionState;
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

export function shouldSaveWriteFileBeforeDocumentDelete(
  input: WriteDirtyDocumentInput & { deletingPath: string },
): boolean {
  if (input.activePath === input.deletingPath) return false;
  return shouldSaveWriteFileBeforeSwitch(input);
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

export function shouldApplyWriteCompletionResult(input: {
  requestId: number;
  latestRequestId: number;
  requestedWorkspace: string;
  currentWorkspace: string;
  requestedPath: string;
  currentPath: string | null;
}): boolean {
  return (
    input.requestId === input.latestRequestId &&
    input.requestedWorkspace === input.currentWorkspace &&
    input.requestedPath === input.currentPath
  );
}

export async function shouldUseSelectedWriteWorkspace(
  workspace: string,
  onWorkspaceSelected?: (workspace: string) => boolean | void | Promise<boolean | void>,
): Promise<boolean> {
  return (await onWorkspaceSelected?.(workspace)) !== false;
}

export function getWriteWorkspaceSwitchState(): WriteDocumentViewState & {
  files: WriteFileEntry[];
} {
  return {
    files: [],
    ...getWriteClearedDocumentState(),
  };
}

export function getWriteOpenDocumentState(
  path: string,
  content: string,
): WriteDocumentViewState {
  return {
    activePath: path,
    content,
    savedContent: content,
    completion: "",
    selection: { selectionStart: 0, selectionEnd: 0 },
  };
}

export function getWriteClearedDocumentState(): WriteDocumentViewState {
  return {
    activePath: null,
    content: "",
    savedContent: "",
    completion: "",
    selection: { selectionStart: 0, selectionEnd: 0 },
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
  maxPrefixChars = WRITE_COMPLETION_PREFIX_MAX_CHARS,
  maxSuffixChars = WRITE_COMPLETION_SUFFIX_MAX_CHARS,
}: {
  content: string;
  selection: WriteEditorSelectionState;
  maxPrefixChars?: number;
  maxSuffixChars?: number;
}): { prefix: string; suffix: string } {
  const normalized = normalizeWriteEditorSelection(selection, content.length);
  const prefixStart = Math.max(0, normalized.selectionStart - Math.max(0, maxPrefixChars));
  const suffixEnd = Math.min(content.length, normalized.selectionEnd + Math.max(0, maxSuffixChars));
  return {
    prefix: content.slice(prefixStart, normalized.selectionStart),
    suffix: content.slice(normalized.selectionEnd, suffixEnd),
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
  attachmentIds?: string[];
  mode?: "agent" | "plan";
  goalMode?: boolean;
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
    attachmentIds: input.attachmentIds ?? [],
    mode: input.mode ?? "agent",
    goalMode: input.goalMode ?? false,
  };
}

export function getWriteAssistantPromptText(
  text: string,
  attachmentCount: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const trimmed = text.trim();
  if (trimmed) return trimmed;
  if (attachmentCount <= 0) return "";
  return t(
    attachmentCount === 1
      ? "composer.attachmentOnlyMessageSingle"
      : "composer.attachmentOnlyMessageMultiple",
  );
}

export function normalizeWriteDocumentPathInput(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .join("/");
}

export function isWriteMarkdownDocumentPath(path: string): boolean {
  return getWriteDocumentPathValidationError(path) === null;
}

export function getWriteDocumentPathValidationError(
  value: string,
): WriteDocumentPathValidationError | null {
  const normalized = normalizeWriteDocumentPathInput(value);
  if (!normalized) return "empty";
  if (normalized.endsWith("/")) return "directory";
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment)) return "empty-segment";
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "dot-segment";
  }
  if (/^[A-Za-z]:$/.test(segments[0] ?? "")) return "drive-root";
  const filename = segments.at(-1) ?? "";
  const extension = WRITE_MARKDOWN_EXTENSIONS.find((candidate) =>
    filename.toLowerCase().endsWith(candidate),
  );
  if (!extension) return "extension";
  if (!filename.slice(0, -extension.length).trim()) return "filename";
  return null;
}

export function getNextWriteDocumentPath(
  files: readonly Pick<WriteFileEntry, "path">[],
): string {
  const existing = new Set(files.map((file) => file.path.toLowerCase()));
  if (!existing.has("untitled.md")) return "untitled.md";
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `untitled-${index}.md`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  return `untitled-${Date.now()}.md`;
}

export function getWriteAssistantVisibleItems(
  items: readonly Item[],
  limit = 80,
): Item[] {
  // Write and Code timelines share chronological turn grouping. Sorting before
  // windowing prevents replayed or late-updated items from splitting a turn at
  // the visible history boundary.
  const sortedItems = sortTimelineItems(items);
  if (sortedItems.length <= limit) return sortedItems;
  const limitedStartIndex = Math.max(0, sortedItems.length - limit);
  const firstLimitedTurnId = getTimelineItemTurnId(sortedItems[limitedStartIndex]);
  let startIndex = limitedStartIndex;
  while (
    startIndex > 0 &&
    getTimelineItemTurnId(sortedItems[startIndex - 1]) === firstLimitedTurnId
  ) {
    startIndex -= 1;
  }
  return sortedItems.slice(startIndex);
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

export function isWriteEditorSelectionEqual(
  left: WriteEditorSelectionState,
  right: WriteEditorSelectionState,
): boolean {
  return left.selectionStart === right.selectionStart && left.selectionEnd === right.selectionEnd;
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

export function getWriteContextMenuPosition({
  clientX,
  clientY,
  viewportWidth,
  viewportHeight,
  menuWidth = WRITE_CONTEXT_MENU_WIDTH_PX,
  menuHeight = WRITE_CONTEXT_MENU_HEIGHT_PX,
  margin = WRITE_CONTEXT_MENU_VIEWPORT_MARGIN_PX,
}: {
  clientX: number;
  clientY: number;
  viewportWidth: number;
  viewportHeight: number;
  menuWidth?: number;
  menuHeight?: number;
  margin?: number;
}): { x: number; y: number } {
  const safeMargin = Math.max(0, margin);
  const maxX = Math.max(safeMargin, viewportWidth - menuWidth - safeMargin);
  const maxY = Math.max(safeMargin, viewportHeight - menuHeight - safeMargin);
  return {
    x: Math.min(maxX, Math.max(safeMargin, clientX)),
    y: Math.min(maxY, Math.max(safeMargin, clientY)),
  };
}

export function getWriteSidebarDividerClassName(isDragging: boolean): string {
  return isDragging
    ? "ds-workbench-divider ds-write-sidebar-divider is-dragging"
    : "ds-workbench-divider ds-write-sidebar-divider";
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString();
}

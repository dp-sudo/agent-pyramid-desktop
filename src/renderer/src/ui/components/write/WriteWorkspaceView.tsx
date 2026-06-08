import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
  EditorView,
  ViewUpdate,
  keymap,
  placeholder,
  type KeyBinding,
} from "@codemirror/view";
import { minimalSetup } from "codemirror";
import { useTranslation } from "react-i18next";
import type {
  AssistantItem,
  FileDiffLine,
  Item,
  WriteAction,
  WriteFileEntry,
  WriteInlineEditAction,
  WriteMediaReference,
  WriteTreeNode,
  ModelConfigProfile,
} from "../../../../../shared/agent-contracts";
import {
  RIGHT_INSPECTOR_MAX_WIDTH,
  RIGHT_INSPECTOR_MIN_WIDTH,
} from "../../preferences";
import {
  getActiveThreadInFlightTurn,
  INITIAL_WRITE_SELECTION,
  useWorkbench,
  type WriteMemoryState,
  type WriteCompletionState,
  type WritePendingInlineEdit,
  type WriteSaveStatus,
  type WriteSelectionState,
  type WriteWorkspaceState,
} from "../../store/WorkbenchContext";
import { AssistantMarkdown } from "../chat/AssistantMarkdown";
import { MessageTimeline } from "../chat/MessageTimeline";
import { PendingApprovalPanel } from "../chat/PendingApprovalPanel";
import { ComposerInputSurface } from "../composer/FloatingComposer";
import { FloatingComposerModelPicker } from "../composer/FloatingComposerModelPicker";

const AUTOSAVE_DELAY_MS = 800;
const COMPLETION_DELAY_MS = 650;
const COMPLETION_MIN_TRAILING_CHARS = 10;
const WRITE_WATCH_INTERVAL_MS = 5000;
const WRITE_ASSISTANT_WIDTH_KEYBOARD_STEP = 24;
export const WRITE_ASSISTANT_COMPOSER_TOOLS = ["model", "memory", "action"] as const;

export interface WriteWorkspaceViewProps {
  onWorkspaceSelected?: (workspace: string) => boolean | void | Promise<boolean | void>;
  onAssistantSend?: (
    draftText: string,
    writeState: WriteWorkspaceState,
  ) => Promise<boolean>;
  onAssistantInterrupt?: () => void;
  onApprove?: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
}

export function WriteWorkspaceView({
  onWorkspaceSelected,
  onAssistantSend,
  onAssistantInterrupt,
  onApprove,
}: WriteWorkspaceViewProps = {}): ReactElement {
  const { t } = useTranslation();
  const { state, actions } = useWorkbench();
  const writeState = state.writeWorkspace;
  const {
    activeFile,
    assistantDraft,
    assistantOpen,
    completionState,
    content,
    error,
    files,
    lifecycleState,
    listLoading,
    pendingInlineEdit,
    savedContent,
    search,
    selection,
    status,
    workspace,
  } = writeState;
  const completion = completionState.text;
  const writeThreadActive = state.activeThread?.mode === "write";
  const runtimeBusy = writeThreadActive && getActiveThreadInFlightTurn(state) !== null;
  const completionRequestId = useRef(completionState.requestId);
  const listRequestId = useRef(0);
  const openFileRequestId = useRef(0);
  const activePathRef = useRef<string | null>(activeFile);
  const workspaceRootRef = useRef(workspace || state.workspaceRoot);
  const contentRef = useRef(content);
  const savedContentRef = useRef(savedContent);
  const selectionRef = useRef(selection);
  const writeStateRef = useRef(writeState);
  const saveInFlightRef = useRef(false);
  const savePromiseRef = useRef<Promise<boolean> | null>(null);
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const editorActiveFileRef = useRef<string | null>(null);
  const editorEditableCompartmentRef = useRef(new Compartment());
  const assistantComposerRef = useRef<HTMLDivElement | null>(null);
  const syncEditorFromStateRef = useRef(false);
  const [assistantModelPickerOpen, setAssistantModelPickerOpen] = useState(false);

  useEffect(() => {
    activePathRef.current = activeFile;
    workspaceRootRef.current = workspace || state.workspaceRoot;
    contentRef.current = content;
    savedContentRef.current = savedContent;
    selectionRef.current = selection;
    writeStateRef.current = writeState;
    completionRequestId.current = Math.max(
      completionRequestId.current,
      completionState.requestId,
    );
  }, [
    activeFile,
    completionState.requestId,
    content,
    savedContent,
    selection,
    state.workspaceRoot,
    workspace,
    writeState,
  ]);

  useEffect(() => {
    const host = editorHostRef.current;
    if (!host) return undefined;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: contentRef.current,
        selection: createEditorSelection(selectionRef.current, contentRef.current),
        extensions: [
          minimalSetup,
          markdown(),
          placeholder(t("write.editorPlaceholder")),
          EditorView.lineWrapping,
          editorEditableCompartmentRef.current.of(
            EditorView.editable.of(!writeStateRef.current.lifecycleState.readonly),
          ),
          keymap.of(createWriteEditorKeymap()),
          EditorView.updateListener.of(handleCodeMirrorUpdate),
        ],
      }),
    });
    editorViewRef.current = view;
    editorActiveFileRef.current = activePathRef.current;

    return () => {
      view.destroy();
      if (editorViewRef.current === view) {
        editorViewRef.current = null;
      }
    };
  }, [t]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editorEditableCompartmentRef.current.reconfigure(
        EditorView.editable.of(!lifecycleState.readonly),
      ),
    });
  }, [lifecycleState.readonly]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;
    const currentDoc = view.state.doc.toString();
    const activeFileChanged = editorActiveFileRef.current !== activeFile;
    if (currentDoc === content && !activeFileChanged) return;

    const nextSelection = createEditorSelection(selection, content);
    syncEditorFromStateRef.current = true;
    try {
      view.dispatch({
        ...(currentDoc === content
          ? {}
          : { changes: { from: 0, to: currentDoc.length, insert: content } }),
        selection: nextSelection,
      });
      editorActiveFileRef.current = activeFile;
    } finally {
      syncEditorFromStateRef.current = false;
    }
  }, [activeFile, content, selection]);

  useEffect(() => {
    if (!assistantModelPickerOpen) return undefined;

    function closeAssistantModelPicker(): void {
      setAssistantModelPickerOpen(false);
    }

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (assistantComposerRef.current?.contains(target)) return;
      closeAssistantModelPicker();
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        closeAssistantModelPicker();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [assistantModelPickerOpen]);

  async function pickWorkspace(): Promise<string | null> {
    const result = await window.agentApi.workspace.pickDirectory();
    if (!result.ok) {
      actions.setWriteError(result.message);
      return null;
    }
    if (result.value.canceled || !result.value.path) return null;
    if (!await shouldUseSelectedWriteWorkspace(result.value.path, onWorkspaceSelected)) {
      actions.setWriteError(t("write.workspaceSelectionRejected"));
      return null;
    }
    actions.setWorkspaceRoot(result.value.path);
    actions.setWriteWorkspace(result.value.path);
    return result.value.path;
  }

  async function loadList(
    workspaceInput?: string,
    searchInput = search,
    options: { saveBeforeLoad?: boolean } = {},
  ): Promise<void> {
    if (options.saveBeforeLoad && !(await saveCurrentFileBeforeSwitch())) return;
    const selectedWorkspace = workspaceInput ?? await pickWorkspace();
    if (!selectedWorkspace) return;

    const requestId = listRequestId.current + 1;
    listRequestId.current = requestId;
    const currentWorkspace = workspaceRootRef.current;
    const switchingWorkspace = selectedWorkspace !== currentWorkspace;
    if (switchingWorkspace) {
      openFileRequestId.current += 1;
      activePathRef.current = null;
      contentRef.current = "";
      savedContentRef.current = "";
      selectionRef.current = INITIAL_WRITE_SELECTION;
      actions.clearWriteFileStateForWorkspace(selectedWorkspace);
    }

    actions.setWriteListLoading(true);
    actions.setWriteStatus("loading");
    try {
      const result = await window.agentApi.write.list({
        workspace: selectedWorkspace,
        search: searchInput,
      });
      const treeResult = result.ok
        ? await window.agentApi.write.tree({
            workspace: selectedWorkspace,
            search: searchInput,
          })
        : null;
      if (requestId !== listRequestId.current) return;
      if (result.ok) {
        actions.setWriteFiles(result.value);
        let treeError: string | null = null;
        if (treeResult?.ok) {
          actions.setWriteLifecycleState({
            ...writeStateRef.current.lifecycleState,
            tree: treeResult.value,
          });
        } else if (treeResult && !treeResult.ok) {
          treeError = treeResult.message;
        }
        actions.setWriteStatus("idle");
        actions.setWriteError(treeError);
      } else {
        actions.setWriteError(result.message);
      }
    } catch (loadError) {
      if (requestId === listRequestId.current) {
        actions.setWriteError(messageOf(loadError));
      }
    } finally {
      if (requestId === listRequestId.current) {
        actions.setWriteListLoading(false);
      }
    }
  }

  function handleClearSearch(): void {
    actions.setWriteSearch("");
    if (workspaceRootRef.current) {
      void loadList(workspaceRootRef.current, "", { saveBeforeLoad: false });
    }
  }

  async function openFile(path: string): Promise<void> {
    const activeWorkspace = workspaceRootRef.current;
    if (!activeWorkspace) return;
    if (path === activePathRef.current) return;
    if (!(await saveCurrentFileBeforeSwitch())) return;
    const requestId = openFileRequestId.current + 1;
    openFileRequestId.current = requestId;
    actions.setWriteStatus("loading");
    const result = await window.agentApi.write.get({ workspace: activeWorkspace, path });
    if (!shouldApplyWriteOpenResult({
      requestId,
      latestRequestId: openFileRequestId.current,
      requestedWorkspace: activeWorkspace,
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
      selectionRef.current = INITIAL_WRITE_SELECTION;
      actions.openWriteFile(path, result.value.content, {
        readonly: result.value.readonly,
        readonlyReason: result.value.reason ?? null,
      });
      void refreshLifecycleForOpenFile(path, result.value.content, {
        modifiedAt: result.value.modifiedAt,
        size: result.value.size,
        readonly: result.value.readonly,
        readonlyReason: result.value.reason ?? null,
      });
      actions.setWriteError(null);
    } else {
      actions.setWriteError(result.message);
    }
  }

  useEffect(() => {
    if (status !== "saved") return;
    const timer = window.setTimeout(() => actions.setWriteStatus("idle"), 1500);
    return () => window.clearTimeout(timer);
  }, [actions, status]);

  useEffect(() => {
    if (!activeFile || !workspaceRootRef.current) return;
    if (content === savedContent) return;
    const timer = window.setTimeout(() => {
      void save();
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [activeFile, content, savedContent]);

  useEffect(() => {
    if (!activeFile || !workspaceRootRef.current || !lifecycleState.watch) return;
    const timer = window.setInterval(() => {
      const watch = writeStateRef.current.lifecycleState.watch;
      void checkExternalChange(watch?.modifiedAt, watch?.size);
    }, WRITE_WATCH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [activeFile, lifecycleState.watch?.modifiedAt, lifecycleState.watch?.size]);

  useEffect(() => {
    if (!activeFile || !workspaceRootRef.current || lifecycleState.readonly) {
      clearCompletionState();
      return;
    }
    if (content.length < COMPLETION_MIN_TRAILING_CHARS) {
      clearCompletionState();
      return;
    }
    const requestId = completionRequestId.current + 1;
    completionRequestId.current = requestId;
    actions.setWriteCompletionState({
      requestId,
      status: "pending",
      text: "",
      score: 0,
      truncated: false,
      error: null,
    });
    const timer = window.setTimeout(() => {
      void requestCompletion(requestId);
    }, COMPLETION_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [actions, activeFile, content, lifecycleState.readonly, selection.end]);

  async function save(): Promise<void> {
    if (!activePathRef.current || !workspaceRootRef.current) return;
    if (writeStateRef.current.lifecycleState.readonly) {
      actions.setWriteError(writeStateRef.current.lifecycleState.readonlyReason);
      return;
    }
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
      actions.setWriteStatus("saving");
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
          actions.setWriteError(result.message);
          return false;
        }
        savedContentRef.current = nextContent;
        actions.markWriteSaved(nextContent);
        actions.setWriteError(null);
      } catch (saveError) {
        if (activePathRef.current === savingPath && workspaceRootRef.current === savingWorkspace) {
          actions.setWriteError(messageOf(saveError));
        }
        return false;
      } finally {
        saveInFlightRef.current = false;
      }
    }
  }

  async function requestCompletion(requestId: number): Promise<void> {
    const activeWorkspace = workspaceRootRef.current;
    const activePath = activePathRef.current;
    if (!activePath || !activeWorkspace) return;
    const currentContent = contentRef.current;
    const cursor = clampSelectionToContent(selectionRef.current, currentContent);
    const result = await window.agentApi.write.complete({
      workspace: activeWorkspace,
      path: activePath,
      prefix: currentContent.slice(0, cursor.end),
      suffix: currentContent.slice(cursor.end),
    });
    if (requestId !== completionRequestId.current) return;
    if (result.ok) {
      actions.setWriteCompletionState({
        requestId,
        status: result.value.score > 0 ? "ready" : "idle",
        text: result.value.score > 0 ? result.value.completion : "",
        score: result.value.score,
        truncated: result.value.truncated,
        error: null,
      });
      return;
    }
    actions.setWriteCompletionState({
      requestId,
      status: "error",
      text: "",
      score: 0,
      truncated: false,
      error: result.message,
    });
    actions.setWriteError(result.message);
  }

  function clearCompletionState(): void {
    if (
      writeStateRef.current.completionState.status === "idle" &&
      writeStateRef.current.completionState.text === ""
    ) {
      return;
    }
    const requestId = completionRequestId.current + 1;
    completionRequestId.current = requestId;
    actions.setWriteCompletionState(getWriteCompletionResetState(requestId));
  }

  function handleCodeMirrorUpdate(update: ViewUpdate): void {
    if (syncEditorFromStateRef.current) return;
    if (writeStateRef.current.lifecycleState.readonly) return;
    const nextSelection = getWriteSelectionFromEditorState(update.state);
    selectionRef.current = nextSelection;
    if (update.docChanged) {
      const nextContent = update.state.doc.toString();
      const requestId = writeStateRef.current.completionState.requestId + 1;
      completionRequestId.current = requestId;
      contentRef.current = nextContent;
      actions.editWriteDocument(nextContent);
      actions.setWriteSelection(nextSelection);
      return;
    }
    if (update.selectionSet) {
      actions.setWriteSelection(nextSelection);
    }
  }

  function createWriteEditorKeymap(): KeyBinding[] {
    return [
      {
        key: "Tab",
        run(view) {
          const currentCompletion = writeStateRef.current.completionState.text;
          if (!currentCompletion) {
            return indentWithTab.run?.(view) ?? false;
          }
          const currentSelection = getWriteSelectionFromEditorState(view.state);
          const nextState = getWriteCompletionAcceptState(
            view.state.doc.toString(),
            currentCompletion,
            currentSelection,
          );
          const requestId = writeStateRef.current.completionState.requestId + 1;
          completionRequestId.current = requestId;
          view.dispatch({
            changes: {
              from: currentSelection.end,
              insert: currentCompletion,
            },
            selection: createEditorSelection(nextState.selection, nextState.content),
            userEvent: "input.complete",
          });
          actions.setWriteCompletionState(getWriteCompletionResetState(requestId));
          return true;
        },
      },
      {
        key: "Escape",
        run() {
          if (!writeStateRef.current.completionState.text) return false;
          clearCompletionState();
          return true;
        },
      },
    ];
  }

  async function requestLatestAssistantAction(): Promise<void> {
    const activeWorkspace = workspaceRootRef.current;
    const activePath = activePathRef.current;
    if (!activeWorkspace || !activePath) {
      actions.setWriteError(t("write.actionNoActiveFile"));
      return;
    }
    const assistantItem = getLatestAssistantItem(state.items);
    if (!assistantItem?.text.trim()) {
      actions.setWriteError(t("write.actionNoAssistantOutput"));
      return;
    }
    const result = await window.agentApi.write.action({
      workspace: activeWorkspace,
      path: activePath,
      rawAction: assistantItem.text,
    });
    if (!result.ok) {
      actions.setWriteError(result.message);
      return;
    }
    applyWriteActionResult(result.value.action);
  }

  function applyWriteActionResult(action: WriteAction): void {
    if (action.kind === "write:inline-complete") {
      const currentContent = contentRef.current;
      const selectionForAction = {
        start: action.cursor,
        end: action.cursor,
        direction: "none" as const,
      };
      const nextState = getWriteCompletionAcceptState(
        currentContent,
        action.insertText,
        selectionForAction,
      );
      actions.editWriteDocument(nextState.content);
      actions.setWriteSelection(nextState.selection);
      actions.setWriteError(null);
      return;
    }
    if (action.kind === "write:inline-edit") {
      const pending = createWritePendingInlineEdit(action, contentRef.current);
      if (!pending.ok) {
        actions.setWriteError(pending.message);
        return;
      }
      actions.setWritePendingInlineEdit(pending.pendingInlineEdit);
      actions.setWriteError(null);
      return;
    }
    actions.setWriteError(t("write.actionNoDocumentEdit"));
  }

  async function refreshWriteMemory(queryInput = assistantDraft): Promise<WriteMemoryState | null> {
    const activeWorkspace = workspaceRootRef.current;
    if (!activeWorkspace) {
      actions.setWriteError(t("write.actionNoActiveFile"));
      return null;
    }
    const query = getWriteMemoryQuery(queryInput, selectionRef.current, contentRef.current);
    if (!query) {
      const nextMemoryState = {
        ...writeStateRef.current.memoryState,
        query: "",
        loading: false,
        error: null,
        evidence: [],
      };
      actions.setWriteMemoryState(nextMemoryState);
      return nextMemoryState;
    }
    actions.setWriteMemoryState({
      ...writeStateRef.current.memoryState,
      query,
      loading: true,
      error: null,
    });
    const result = await window.agentApi.write.memory({
      workspace: activeWorkspace,
      query,
      activePath: activePathRef.current,
      limit: 5,
    });
    if (!result.ok) {
      actions.setWriteMemoryState({
        ...writeStateRef.current.memoryState,
        query,
        loading: false,
        error: result.message,
        evidence: [],
      });
      actions.setWriteError(result.message);
      return null;
    }
    const nextMemoryState = {
      ...writeStateRef.current.memoryState,
      query: result.value.query,
      loading: false,
      error: null,
      evidence: result.value.evidence,
    };
    actions.setWriteMemoryState(nextMemoryState);
    return nextMemoryState;
  }

  async function sendAssistantWithMemory(text: string): Promise<boolean> {
    if (!onAssistantSend) return false;
    const memoryState = await refreshWriteMemory(text);
    if (!memoryState) return false;
    return onAssistantSend(text, {
      ...writeStateRef.current,
      memoryState,
    });
  }

  function handleSelectAssistantModel(profile: ModelConfigProfile): void {
    actions.setComposerModel(profile.config.model, profile.id);
    actions.setComposerReasoningEffort(profile.config.model_reasoning_effort);
    setAssistantModelPickerOpen(false);
  }

  async function refreshLifecycleForOpenFile(
    path: string,
    fileContent = contentRef.current,
    known?: {
      modifiedAt: string;
      size: number;
      readonly?: boolean;
      readonlyReason?: string | null;
    },
  ): Promise<void> {
    const activeWorkspace = workspaceRootRef.current;
    if (!activeWorkspace) return;
    const [mediaResult, watchResult] = await Promise.all([
      window.agentApi.write.media({
        workspace: activeWorkspace,
        path,
        content: fileContent,
      }),
      window.agentApi.write.watch({
        workspace: activeWorkspace,
        path,
        knownModifiedAt: known?.modifiedAt,
        knownSize: known?.size,
      }),
    ]);
    actions.setWriteLifecycleState({
      ...writeStateRef.current.lifecycleState,
      media: mediaResult.ok ? mediaResult.value.references : [],
      watch: watchResult.ok ? watchResult.value : null,
      readonly: known?.readonly ?? writeStateRef.current.lifecycleState.readonly,
      readonlyReason: known?.readonlyReason ?? writeStateRef.current.lifecycleState.readonlyReason,
    });
    if (!mediaResult.ok) actions.setWriteError(mediaResult.message);
    if (!watchResult.ok) actions.setWriteError(watchResult.message);
  }

  async function checkExternalChange(
    knownModifiedAt?: string,
    knownSize?: number,
  ): Promise<void> {
    const activeWorkspace = workspaceRootRef.current;
    const activePath = activePathRef.current;
    if (!activeWorkspace || !activePath) return;
    const result = await window.agentApi.write.watch({
      workspace: activeWorkspace,
      path: activePath,
      knownModifiedAt,
      knownSize,
    });
    if (result.ok) {
      actions.setWriteLifecycleState({
        ...writeStateRef.current.lifecycleState,
        watch: result.value,
      });
      return;
    }
    actions.setWriteError(result.message);
  }

  async function refreshTree(): Promise<void> {
    const activeWorkspace = workspaceRootRef.current;
    if (!activeWorkspace) return;
    const result = await window.agentApi.write.tree({
      workspace: activeWorkspace,
      search,
    });
    if (result.ok) {
      actions.setWriteLifecycleState({
        ...writeStateRef.current.lifecycleState,
        tree: result.value,
      });
      return;
    }
    actions.setWriteError(result.message);
  }

  async function createFile(): Promise<void> {
    const activeWorkspace = workspaceRootRef.current;
    if (!activeWorkspace) return;
    if (!(await saveCurrentFileBeforeSwitch())) return;
    const path = getNextUntitledMarkdownPath(files);
    const result = await window.agentApi.write.create({
      workspace: activeWorkspace,
      path,
      content: "# Untitled\n",
    });
    if (!result.ok) {
      actions.setWriteError(result.message);
      return;
    }
    await loadList(activeWorkspace, search, { saveBeforeLoad: false });
    await openFile(result.value.path);
  }

  async function renameActiveFile(): Promise<void> {
    const activeWorkspace = workspaceRootRef.current;
    const activePath = activePathRef.current;
    if (!activeWorkspace || !activePath) return;
    if (!(await saveCurrentFileBeforeSwitch())) return;
    const nextPath = getRenamedMarkdownPath(activePath, files);
    const result = await window.agentApi.write.rename({
      workspace: activeWorkspace,
      fromPath: activePath,
      toPath: nextPath,
    });
    if (!result.ok) {
      actions.setWriteError(result.message);
      return;
    }
    activePathRef.current = null;
    await loadList(activeWorkspace, search, { saveBeforeLoad: false });
    await openFile(result.value.path);
  }

  async function deleteActiveFile(): Promise<void> {
    const activeWorkspace = workspaceRootRef.current;
    const activePath = activePathRef.current;
    if (!activeWorkspace || !activePath) return;
    const result = await window.agentApi.write.delete({
      workspace: activeWorkspace,
      path: activePath,
    });
    if (!result.ok) {
      actions.setWriteError(result.message);
      return;
    }
    activePathRef.current = null;
    contentRef.current = "";
    savedContentRef.current = "";
    actions.clearWriteFileStateForWorkspace(activeWorkspace);
    await loadList(activeWorkspace, search, { saveBeforeLoad: false });
  }

  async function exportActiveFile(): Promise<void> {
    const activeWorkspace = workspaceRootRef.current;
    const activePath = activePathRef.current;
    if (!activeWorkspace || !activePath) return;
    const result = await window.agentApi.write.export({
      workspace: activeWorkspace,
      path: activePath,
    });
    if (!result.ok) {
      actions.setWriteError(result.message);
      return;
    }
    actions.setWriteLifecycleState({
      ...writeStateRef.current.lifecycleState,
      exportMarkdown: result.value.markdown,
      exportName: result.value.suggestedName,
    });
    downloadMarkdownExport(result.value.suggestedName, result.value.markdown);
  }

  function confirmInlineEdit(): void {
    const pending = writeStateRef.current.pendingInlineEdit;
    if (!pending) return;
    const result = applyWriteInlineEditAction(contentRef.current, pending.action);
    if (!result.ok) {
      actions.setWriteError(result.message);
      actions.setWritePendingInlineEdit(null);
      return;
    }
    actions.editWriteDocument(result.content);
    actions.setWriteSelection(result.selection);
    actions.setWritePendingInlineEdit(null);
    actions.setWriteError(null);
  }

  const saveDisabled = shouldDisableWriteSave({
    activePath: activeFile,
    workspaceRoot: workspaceRootRef.current,
    content,
    savedContent,
    status,
    readonly: lifecycleState.readonly,
  });
  const activeWorkspace = workspaceRootRef.current;
  const documentDirty = content !== savedContent;
  const documentStatusLabel = getWriteDocumentStatusLabel({
    activeFile,
    dirty: documentDirty,
    readonly: lifecycleState.readonly,
    status,
    t,
  });
  const documentPreviewAvailable = content.trim().length > 0;
  const listState = getWriteListState({
    files,
    listLoading,
    search,
    workspaceRoot: activeWorkspace,
  });
  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <aside
        className="ds-write-sidebar"
        style={{
          width: state.leftSidebarWidth,
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
        <div className="ds-write-workspace-panel">
          <div className="ds-write-workspace-heading">
            <span>{t("write.workspaceLabel")}</span>
            {activeWorkspace ? (
              <button
                className="ds-pill ds-write-refresh-button"
                type="button"
                onClick={() => void loadList(activeWorkspace, search, { saveBeforeLoad: true })}
                title={t("write.refresh")}
              >
                {t("write.refresh")}
              </button>
            ) : null}
          </div>
          <button
            className="ds-pill is-accent ds-write-open-workspace"
            type="button"
            onClick={() => void loadList(undefined, search, { saveBeforeLoad: true })}
          >
            {t("write.openWorkspace")}
          </button>
          {activeWorkspace ? (
            <div
              className="ds-write-workspace-path"
              title={activeWorkspace}
            >
              {formatWriteWorkspacePath(activeWorkspace)}
            </div>
          ) : (
            <div className="ds-write-workspace-hint">{t("write.noWorkspace")}</div>
          )}
        </div>
        {activeWorkspace ? (
          <div className="ds-write-file-actions">
            <button
              className="ds-pill is-accent"
              type="button"
              onClick={() => void createFile()}
            >
              {t("write.newFile")}
            </button>
            {activeFile ? (
              <>
                <button
                  className="ds-pill"
                  type="button"
                  onClick={() => void renameActiveFile()}
                >
                  {t("write.renameFile")}
                </button>
                <button
                  className="ds-pill is-danger"
                  type="button"
                  onClick={() => void deleteActiveFile()}
                >
                  {t("write.deleteFile")}
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        <div className="ds-write-search">
          <input
            value={search}
            onChange={(event) => {
              const nextSearch = event.target.value;
              actions.setWriteSearch(nextSearch);
              if (workspaceRootRef.current) {
                void loadList(workspaceRootRef.current, nextSearch, { saveBeforeLoad: false });
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
            <div className="ds-sidebar-empty">
              <span>{t("write.emptyFiles")}</span>
              <button className="ds-pill is-accent" type="button" onClick={() => void createFile()}>
                {t("write.newFile")}
              </button>
            </div>
          ) : null}
          {listState === "empty-search" ? (
            <div className="ds-sidebar-empty">{t("write.emptySearch", { search })}</div>
          ) : null}
          <WriteFileTree
            nodes={lifecycleState.tree.length > 0 ? lifecycleState.tree : files.map(toFlatTreeNode)}
            activeFile={activeFile}
            onOpen={(path) => void openFile(path)}
          />
        </div>
      </aside>
      <div className="ds-write-main">
        <div className="ds-write-editor">
          <div className="ds-write-document-bar">
            <div className="ds-write-document-title">
              <span>{activeFile ?? t("write.noActiveFile")}</span>
              <small>{documentStatusLabel}</small>
            </div>
            <div className="ds-write-document-actions">
              <div className="ds-segmented-control ds-write-view-toggle">
                <button
                  type="button"
                  className={writeState.previewMode === "source" ? "is-active" : ""}
                  onClick={() => actions.setWritePreviewMode("source")}
                >
                  {t("write.sourceMode")}
                </button>
                <button
                  type="button"
                  className={writeState.previewMode === "split" ? "is-active" : ""}
                  onClick={() => actions.setWritePreviewMode("split")}
                  disabled={!activeFile}
                >
                  {t("write.splitMode")}
                </button>
                <button
                  type="button"
                  className={writeState.previewMode === "preview" ? "is-active" : ""}
                  onClick={() => actions.setWritePreviewMode("preview")}
                  disabled={!activeFile}
                >
                  {t("write.previewMode")}
                </button>
              </div>
              {!assistantOpen ? (
                <button
                  className="ds-pill"
                  type="button"
                  onClick={() => actions.setWriteAssistantOpen(true)}
                >
                  {t("write.showAssistant")}
                </button>
              ) : null}
              <button
                className="ds-pill"
                type="button"
                onClick={() => void checkExternalChange(
                  lifecycleState.watch?.modifiedAt,
                  lifecycleState.watch?.size,
                )}
                disabled={!activeFile}
              >
                {t("write.checkChanges")}
              </button>
              <button
                className="ds-pill"
                type="button"
                onClick={() => void exportActiveFile()}
                disabled={!activeFile}
              >
                {t("write.exportFile")}
              </button>
              <button
                className={`ds-pill ${documentDirty ? "is-accent" : ""}`}
                type="button"
                onClick={() => void save()}
                disabled={saveDisabled}
              >
                {documentDirty ? t("write.save") : t("write.saved")}
              </button>
            </div>
          </div>
          <div className={`ds-write-editor-frame is-${writeState.previewMode}`}>
            <div
              className="ds-write-source-pane"
              aria-hidden={writeState.previewMode === "preview"}
            >
              <div
                ref={editorHostRef}
                className="ds-write-codemirror"
                aria-label={t("write.editorPlaceholder")}
              />
              {completion && writeState.previewMode !== "preview" ? (
                <div className="ds-write-ghost">{completion}</div>
              ) : null}
            </div>
            {writeState.previewMode !== "source" ? (
              <WriteDocumentPreview
                content={content}
                empty={!documentPreviewAvailable}
                media={lifecycleState.media}
              />
            ) : null}
          </div>
          {pendingInlineEdit ? (
            <WriteInlineEditReview
              pending={pendingInlineEdit}
              onApply={confirmInlineEdit}
              onCancel={() => actions.setWritePendingInlineEdit(null)}
            />
          ) : null}
          <div className="ds-write-status">
            <span className={`ds-write-status-message ${status === "error" ? "is-error" : ""}`}>
              {status === "error" ? `${t("write.error")}: ${error ?? ""}` : documentStatusLabel}
            </span>
            {lifecycleState.readonly ? (
              <span className="ds-write-context-meter">{t("write.readonlyFile")}</span>
            ) : null}
            {activeFile ? (
              <span className="ds-write-context-meter">
                {selection.start === selection.end
                  ? t("write.cursorAt", { offset: selection.end })
                  : t("write.selectionRange", {
                      count: selection.end - selection.start,
                    })}
              </span>
            ) : null}
          </div>
          <WriteLifecyclePanel
            lifecycleState={lifecycleState}
            onDismissExport={() => actions.setWriteLifecycleState({
              ...writeState.lifecycleState,
              exportMarkdown: null,
              exportName: null,
            })}
          />
        </div>
        {assistantOpen ? (
          <>
          <div
            className="ds-write-assistant-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-valuemin={RIGHT_INSPECTOR_MIN_WIDTH}
            aria-valuemax={RIGHT_INSPECTOR_MAX_WIDTH}
            aria-valuenow={state.rightSidebarWidth}
            tabIndex={0}
            onKeyDown={(event) => {
              const next = getNextWriteAssistantWidth(state.rightSidebarWidth, event.key);
              if (next === state.rightSidebarWidth) return;
              event.preventDefault();
              actions.setRightSidebarWidth(next);
            }}
            onPointerDown={(event) => {
              const startX = event.clientX;
              const startWidth = state.rightSidebarWidth;
              const target = event.currentTarget;
              target.setPointerCapture(event.pointerId);
              const onMove = (ev: PointerEvent): void => {
                const dx = startX - ev.clientX;
                actions.setRightSidebarWidth(clampWriteAssistantWidth(startWidth + dx));
              };
              const onUp = (): void => {
                target.removeEventListener("pointermove", onMove);
                target.removeEventListener("pointerup", onUp);
              };
              target.addEventListener("pointermove", onMove);
              target.addEventListener("pointerup", onUp);
            }}
          />
          <aside className="ds-write-assistant" style={{ width: state.rightSidebarWidth }}>
            <div className="ds-write-assistant-header">
              <strong>{t("write.assistantTitle")}</strong>
              <div className="ds-write-assistant-actions">
                <button
                  type="button"
                  className="ds-pill"
                  onClick={() => actions.setWriteAssistantOpen(false)}
                >
                  {t("write.hideAssistant")}
                </button>
                {runtimeBusy && onAssistantInterrupt ? (
                <button
                  type="button"
                  className="ds-pill"
                  onClick={onAssistantInterrupt}
                >
                  {t("write.assistantStop")}
                </button>
                ) : null}
              </div>
            </div>
            <div className="ds-write-context-strip">
              <span>{activeFile ?? t("write.noActiveFile")}</span>
              <span>
                {selection.start === selection.end
                  ? t("write.noSelection")
                  : t("write.selectedChars", { count: selection.end - selection.start })}
              </span>
              <span>{t("write.recentEdits", { count: writeState.recentEdits.length })}</span>
              <button
                type="button"
                className="ds-write-memory-toggle"
                onClick={() => actions.setWriteMemoryState({
                  ...writeState.memoryState,
                  expanded: !writeState.memoryState.expanded,
                })}
              >
                {t("write.memoryEvidence", { count: writeState.memoryState.evidence.length })}
              </button>
            </div>
            {writeState.memoryState.expanded ? (
              <WriteMemoryEvidencePanel
                memoryState={writeState.memoryState}
                onRefresh={() => void refreshWriteMemory()}
              />
            ) : null}
            <div className="ds-write-assistant-timeline">
              {writeThreadActive ? (
                <>
                  <MessageTimeline onApprove={onApprove} />
                  <PendingApprovalPanel onApprove={onApprove} />
                </>
              ) : (
                <div className="ds-sidebar-empty">{t("write.noAssistantThread")}</div>
              )}
            </div>
            <div ref={assistantComposerRef} className="ds-write-assistant-composer">
              <ComposerInputSurface
                value={assistantDraft}
                onChange={actions.setWriteAssistantDraft}
                onSend={sendAssistantWithMemory}
                onInterrupt={onAssistantInterrupt}
                placeholder={t("write.assistantPlaceholder")}
                disabled={!onAssistantSend}
                runtimeBusy={runtimeBusy}
                variant="write"
                toolbarLeft={
                  <>
                    <button
                      type="button"
                      className="ds-composer-model-button"
                      onClick={() => setAssistantModelPickerOpen((value) => !value)}
                    >
                      <span>{state.composer.model}</span>
                      <span>{state.composer.reasoningEffort ?? state.modelConfig.model_reasoning_effort}</span>
                    </button>
                    {assistantModelPickerOpen ? (
                      <FloatingComposerModelPicker
                        profiles={state.modelProfiles?.profiles ?? []}
                        selectedModel={state.composer.model}
                        selectedProfileId={state.composer.modelProfileId}
                        selectedReasoningEffort={
                          state.composer.reasoningEffort ?? state.modelConfig.model_reasoning_effort
                        }
                        onSelectModel={handleSelectAssistantModel}
                        onSelectReasoningEffort={actions.setComposerReasoningEffort}
                      />
                    ) : null}
                    <button
                      type="button"
                      className="ds-composer-model-button"
                      onClick={() => actions.setWriteMemoryState({
                        ...writeState.memoryState,
                        expanded: !writeState.memoryState.expanded,
                      })}
                    >
                      <span>{t("write.memoryTool")}</span>
                      <span>{writeState.memoryState.evidence.length}</span>
                    </button>
                    <button
                      type="button"
                      className="ds-composer-model-button"
                      onClick={() => void requestLatestAssistantAction()}
                      disabled={!activeFile || runtimeBusy}
                    >
                      <span>{t("write.actionTool")}</span>
                    </button>
                  </>
                }
                toolbarBadges={
                  activeFile ? (
                    <span className="ds-composer-mode-chip">{t("routes.write")}</span>
                  ) : null
                }
              />
            </div>
          </aside>
          </>
        ) : null}
      </div>
    </div>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function WriteFileTree({
  nodes,
  activeFile,
  onOpen,
  depth = 0,
}: {
  nodes: WriteTreeNode[];
  activeFile: string | null;
  onOpen(path: string): void;
  depth?: number;
}): ReactElement {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === "directory") {
          return (
            <div key={node.path} className="ds-write-tree-group">
              <div className="ds-write-tree-directory" style={{ paddingLeft: 10 + depth * 12 }}>
                {node.name}
              </div>
              <WriteFileTree
                nodes={node.children ?? []}
                activeFile={activeFile}
                onOpen={onOpen}
                depth={depth + 1}
              />
            </div>
          );
        }
        return (
          <button
            key={node.path}
            type="button"
            className={`ds-write-file-row ${node.path === activeFile ? "is-active" : ""}`}
            onClick={() => onOpen(node.path)}
            title={`${node.path}${node.reason ? ` · ${node.reason}` : ""}`}
            style={{ paddingLeft: 10 + depth * 12 }}
          >
            <span>{node.name}{node.readonly ? " · RO" : ""}</span>
            <small>{formatWriteTreeFileMeta(node)}</small>
          </button>
        );
      })}
    </>
  );
}

function WriteLifecyclePanel({
  lifecycleState,
  onDismissExport,
}: {
  lifecycleState: WriteWorkspaceState["lifecycleState"];
  onDismissExport(): void;
}): ReactElement | null {
  const { t } = useTranslation();
  if (
    !lifecycleState.readonly &&
    lifecycleState.media.length === 0 &&
    !lifecycleState.watch?.changed &&
    !lifecycleState.exportMarkdown
  ) {
    return null;
  }
  return (
    <section className="ds-write-lifecycle-panel">
      {lifecycleState.readonly ? (
        <div className="ds-write-lifecycle-row">
          <strong>{t("write.readonlyFile")}</strong>
          <span>{lifecycleState.readonlyReason}</span>
        </div>
      ) : null}
      {lifecycleState.watch?.changed ? (
        <div className="ds-write-lifecycle-row">
          <strong>{t("write.externalChange")}</strong>
          <span>{lifecycleState.watch.exists ? lifecycleState.watch.modifiedAt : t("write.deletedExternally")}</span>
        </div>
      ) : null}
      {lifecycleState.media.length > 0 ? (
        <div className="ds-write-lifecycle-row">
          <strong>{t("write.mediaReferences", { count: lifecycleState.media.length })}</strong>
          <span>{summarizeMediaReferences(lifecycleState.media)}</span>
        </div>
      ) : null}
      {lifecycleState.media.some((reference) => reference.dataUrl) ? (
        <div className="ds-write-media-preview-list">
          {lifecycleState.media
            .filter((reference) => reference.dataUrl)
            .map((reference) => (
              <figure key={`${reference.path}:${reference.rawTarget}`}>
                <img src={reference.dataUrl} alt={reference.alt || reference.rawTarget} />
                <figcaption>{reference.path}</figcaption>
              </figure>
            ))}
        </div>
      ) : null}
      {lifecycleState.exportMarkdown ? (
        <div className="ds-write-lifecycle-export">
          <div>
            <strong>{t("write.exportReady", { name: lifecycleState.exportName })}</strong>
            <button type="button" className="ds-pill" onClick={onDismissExport}>
              {t("common.dismiss")}
            </button>
          </div>
          <pre>{lifecycleState.exportMarkdown.slice(0, 1200)}</pre>
        </div>
      ) : null}
    </section>
  );
}

function WriteDocumentPreview({
  content,
  empty,
  media,
}: {
  content: string;
  empty: boolean;
  media: WriteMediaReference[];
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="ds-write-preview-pane">
      {empty ? (
        <div className="ds-write-preview-empty">{t("write.previewEmpty")}</div>
      ) : (
        <article className="ds-write-preview-document">
          <AssistantMarkdown
            text={content}
            imageSrcResolver={(src) => resolveWritePreviewImageSrc(src, media)}
          />
        </article>
      )}
    </div>
  );
}

function WriteInlineEditReview({
  pending,
  onApply,
  onCancel,
}: {
  pending: WritePendingInlineEdit;
  onApply(): void;
  onCancel(): void;
}): ReactElement {
  const { t } = useTranslation();
  const preview = buildWriteInlineEditDiffPreview(pending.action);
  return (
    <section className="ds-write-inline-review">
      <div className="ds-write-inline-review-header">
        <div>
          <strong>{t("write.inlineEditTitle")}</strong>
          <span>{pending.action.summary}</span>
        </div>
        <div className="ds-write-inline-review-actions">
          <button type="button" className="ds-pill" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button type="button" className="ds-pill is-accent" onClick={onApply}>
            {t("write.applyInlineEdit")}
          </button>
        </div>
      </div>
      <div className="ds-diff-preview">
        <div className="ds-diff-preview-header">
          <span>{pending.action.path}</span>
          <span>+{preview.added} / -{preview.removed}</span>
        </div>
        <div className="ds-diff-preview-lines">
          {preview.lines.map((line, index) => (
            <div
              key={`${index}:${line.type}:${line.text}`}
              className={`ds-diff-line is-${line.type}`}
            >
              <span>{line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}</span>
              <code>{line.text || " "}</code>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function WriteMemoryEvidencePanel({
  memoryState,
  onRefresh,
}: {
  memoryState: WriteMemoryState;
  onRefresh(): void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <section className="ds-write-memory-panel">
      <div className="ds-write-memory-header">
        <span>
          {memoryState.loading
            ? t("write.memoryLoading")
            : t("write.memoryQuery", { query: memoryState.query || "—" })}
        </span>
        <button type="button" className="ds-pill" onClick={onRefresh} disabled={memoryState.loading}>
          {t("write.memoryRefresh")}
        </button>
      </div>
      {memoryState.error ? (
        <div className="ds-write-memory-error">{memoryState.error}</div>
      ) : null}
      {memoryState.evidence.length === 0 && !memoryState.loading ? (
        <div className="ds-write-memory-empty">{t("write.memoryEmpty")}</div>
      ) : null}
      {memoryState.evidence.map((item) => (
        <article key={item.id} className="ds-write-memory-item">
          <div>
            <strong>{item.path}</strong>
            <span>{item.score.toFixed(2)}</span>
          </div>
          <p>{item.snippet}</p>
        </article>
      ))}
    </section>
  );
}

export function getWriteSelectionFromEditorState(state: EditorState): WriteSelectionState {
  const range = state.selection.main;
  return {
    start: Math.min(range.anchor, range.head),
    end: Math.max(range.anchor, range.head),
    direction: range.anchor === range.head
      ? "none"
      : range.anchor < range.head
        ? "forward"
        : "backward",
  };
}

export function createEditorSelection(
  selection: WriteSelectionState,
  content: string,
): EditorSelection {
  const clamped = clampSelectionToContent(selection, content);
  if (clamped.direction === "backward") {
    return EditorSelection.single(clamped.end, clamped.start);
  }
  return EditorSelection.single(clamped.start, clamped.end);
}

function clampSelectionToContent(
  selection: WriteSelectionState,
  content: string,
): WriteSelectionState {
  const start = Math.min(Math.max(0, selection.start), content.length);
  const end = Math.min(Math.max(start, selection.end), content.length);
  return { start, end, direction: selection.direction };
}

export function getWriteCompletionResetState(requestId: number): WriteCompletionState {
  return {
    requestId,
    status: "idle",
    text: "",
    score: 0,
    truncated: false,
    error: null,
  };
}

export interface WriteSaveStateInput {
  activePath: string | null;
  workspaceRoot: string;
  content: string;
  savedContent: string;
  status: WriteSaveStatus;
  readonly?: boolean;
}

export function shouldDisableWriteSave(input: WriteSaveStateInput): boolean {
  return (
    !input.activePath ||
    !input.workspaceRoot ||
    Boolean(input.readonly) ||
    input.status === "loading" ||
    input.status === "saving" ||
    input.content === input.savedContent
  );
}

export function shouldSaveWriteFileBeforeSwitch(input: {
  activePath: string | null;
  workspaceRoot: string;
  content: string;
  savedContent: string;
}): boolean {
  return Boolean(input.activePath && input.workspaceRoot && input.content !== input.savedContent);
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

export function formatWriteWorkspacePath(workspace: string): string {
  const normalized = workspace.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length <= 2) return workspace;
  return `${segments.at(-2)}/${segments.at(-1)}`;
}

export function getWriteDocumentStatusLabel(input: {
  activeFile: string | null;
  dirty: boolean;
  readonly: boolean;
  status: WriteSaveStatus;
  t: (key: string, options?: Record<string, unknown>) => string;
}): string {
  if (!input.activeFile) return input.t("write.noActiveFile");
  if (input.readonly) return input.t("write.readonlyFile");
  if (input.status === "saving") return input.t("write.saving");
  if (input.status === "saved") return input.t("write.saved");
  if (input.dirty) return input.t("write.unsaved");
  return input.t("write.saved");
}

export function clampWriteAssistantWidth(width: number): number {
  return Math.min(RIGHT_INSPECTOR_MAX_WIDTH, Math.max(RIGHT_INSPECTOR_MIN_WIDTH, width));
}

export function getNextWriteAssistantWidth(
  currentWidth: number,
  key: string,
  step = WRITE_ASSISTANT_WIDTH_KEYBOARD_STEP,
): number {
  if (key === "ArrowLeft") return clampWriteAssistantWidth(currentWidth + step);
  if (key === "ArrowRight") return clampWriteAssistantWidth(currentWidth - step);
  if (key === "Home") return RIGHT_INSPECTOR_MIN_WIDTH;
  if (key === "End") return RIGHT_INSPECTOR_MAX_WIDTH;
  return currentWidth;
}

export function formatWriteFileMeta(file: WriteFileEntry): string {
  return `${formatBytes(file.size)} · ${formatDate(file.modifiedAt)}${file.readonly ? " · RO" : ""}`;
}

export function formatWriteTreeFileMeta(file: WriteTreeNode): string {
  if (file.kind !== "file") return "";
  return `${formatBytes(file.size ?? 0)}${file.modifiedAt ? ` · ${formatDate(file.modifiedAt)}` : ""}`;
}

export function toFlatTreeNode(file: WriteFileEntry): WriteTreeNode {
  return {
    kind: "file",
    name: file.path.split("/").at(-1) ?? file.path,
    path: file.path,
    size: file.size,
    modifiedAt: file.modifiedAt,
    readonly: file.readonly,
    ...(file.reason ? { reason: file.reason } : {}),
  };
}

export function getNextUntitledMarkdownPath(files: WriteFileEntry[]): string {
  const existing = new Set(files.map((file) => file.path));
  let index = 1;
  while (existing.has(`untitled-${index}.md`)) {
    index += 1;
  }
  return `untitled-${index}.md`;
}

export function getRenamedMarkdownPath(path: string, files: WriteFileEntry[]): string {
  const existing = new Set(files.map((file) => file.path));
  const extensionIndex = path.lastIndexOf(".");
  const base = extensionIndex >= 0 ? path.slice(0, extensionIndex) : path;
  const extension = extensionIndex >= 0 ? path.slice(extensionIndex) : ".md";
  let candidate = `${base}-renamed${extension}`;
  let index = 2;
  while (existing.has(candidate)) {
    candidate = `${base}-renamed-${index}${extension}`;
    index += 1;
  }
  return candidate;
}

export function summarizeMediaReferences(references: WriteMediaReference[]): string {
  const missing = references.filter((reference) => !reference.exists && !reference.external).length;
  const external = references.filter((reference) => reference.external).length;
  const previewed = references.filter((reference) => reference.dataUrl).length;
  return `${references.length} total · ${missing} missing · ${external} external · ${previewed} previews`;
}

export function resolveWritePreviewImageSrc(
  src: string,
  references: WriteMediaReference[],
): string | null {
  const trimmed = src.trim();
  if (!trimmed) return null;
  const match = references.find(
    (reference) =>
      reference.rawTarget === trimmed ||
      reference.path === trimmed ||
      reference.path?.replaceAll("\\", "/") === trimmed.replaceAll("\\", "/"),
  );
  return match?.dataUrl ?? null;
}

export function downloadMarkdownExport(name: string, markdown: string): void {
  if (typeof document === "undefined" || typeof URL === "undefined") return;
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export interface WriteDocumentStateUpdate {
  content: string;
  completion: string;
  selection: WriteSelectionState;
}

export function getWriteDocumentEditState(
  nextContent: string,
  selection: WriteSelectionState = INITIAL_WRITE_SELECTION,
): WriteDocumentStateUpdate {
  return {
    content: nextContent,
    completion: "",
    selection,
  };
}

export function getWriteCompletionAcceptState(
  content: string,
  completion: string,
  selection: WriteSelectionState = {
    start: content.length,
    end: content.length,
    direction: "none",
  },
): WriteDocumentStateUpdate {
  const cursor = clampSelectionToContent(selection, content).end;
  const nextContent = `${content.slice(0, cursor)}${completion}${content.slice(cursor)}`;
  const nextCursor = cursor + completion.length;
  return {
    content: nextContent,
    completion: "",
    selection: {
      start: nextCursor,
      end: nextCursor,
      direction: "none",
    },
  };
}

export function getWriteMemoryQuery(
  assistantDraft: string,
  selection: WriteSelectionState,
  content: string,
): string {
  const prompt = assistantDraft.trim();
  if (prompt) return prompt;
  const clamped = clampSelectionToContent(selection, content);
  const selected = content.slice(clamped.start, clamped.end).trim();
  if (selected) return selected;
  return content
    .slice(Math.max(0, clamped.end - 240), clamped.end)
    .trim();
}

export function getLatestAssistantItem(items: Item[]): AssistantItem | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "assistant") return item;
  }
  return null;
}

export function createWritePendingInlineEdit(
  action: WriteInlineEditAction,
  content: string,
): { ok: true; pendingInlineEdit: WritePendingInlineEdit } | { ok: false; message: string } {
  const validation = validateWriteInlineEditScope(content, action);
  if (!validation.ok) return validation;
  return {
    ok: true,
    pendingInlineEdit: {
      id: `write-edit-${Date.now()}`,
      action,
      before: action.scope.originalText,
      after: action.replacement,
    },
  };
}

export function applyWriteInlineEditAction(
  content: string,
  action: WriteInlineEditAction,
): { ok: true; content: string; selection: WriteSelectionState } | { ok: false; message: string } {
  const validation = validateWriteInlineEditScope(content, action);
  if (!validation.ok) return validation;
  const nextContent = `${content.slice(0, action.scope.start)}${action.replacement}${content.slice(action.scope.end)}`;
  const cursor = action.scope.start + action.replacement.length;
  return {
    ok: true,
    content: nextContent,
    selection: {
      start: cursor,
      end: cursor,
      direction: "none",
    },
  };
}

export function validateWriteInlineEditScope(
  content: string,
  action: WriteInlineEditAction,
): { ok: true } | { ok: false; message: string } {
  if (action.scope.start < 0 || action.scope.end < action.scope.start) {
    return { ok: false, message: "Write inline edit scope is invalid." };
  }
  if (action.scope.end > content.length) {
    return { ok: false, message: "Write inline edit scope is outside the current document." };
  }
  const currentScope = content.slice(action.scope.start, action.scope.end);
  if (currentScope !== action.scope.originalText) {
    return {
      ok: false,
      message: "Write inline edit scope changed before apply. Review the latest document and retry.",
    };
  }
  return { ok: true };
}

export function buildWriteInlineEditDiffPreview(action: WriteInlineEditAction): {
  added: number;
  removed: number;
  lines: FileDiffLine[];
} {
  const originalLines = splitDiffLines(action.scope.originalText);
  const replacementLines = splitDiffLines(action.replacement);
  return {
    added: replacementLines.length,
    removed: originalLines.length,
    lines: [
      ...originalLines.map((text) => ({ type: "removed" as const, text })),
      ...replacementLines.map((text) => ({ type: "added" as const, text })),
    ],
  };
}

function splitDiffLines(value: string): string[] {
  if (!value) return [];
  return value.split(/\r?\n/);
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString();
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 102.4) / 10} KB`;
  return `${Math.round(value / 1024 / 102.4) / 10} MB`;
}

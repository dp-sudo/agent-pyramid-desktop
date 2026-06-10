import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type RefObject,
} from "react";

export interface ComposerDraftState {
  draftText: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  clearDraft(): void;
  setDraftText(text: string): void;
  handleDraftChange(event: ChangeEvent<HTMLTextAreaElement>): void;
}

export function useComposerDraft(initialText = ""): ComposerDraftState {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [draftText, setDraftText] = useState(initialText);

  useEffect(() => {
    syncComposerTextareaHeight(textareaRef.current);
  }, [draftText]);

  function handleDraftChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    const nextText = event.target.value;
    setDraftText(nextText);
    syncComposerTextareaHeight(event.currentTarget);
  }

  return {
    draftText,
    textareaRef,
    clearDraft: () => setDraftText(""),
    setDraftText,
    handleDraftChange,
  };
}

export function syncComposerTextareaHeight(
  textarea: { style: { height: string }; scrollHeight: number } | null,
): void {
  if (!textarea) return;
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

export function shouldSubmitComposerKeyboardEvent({
  key,
  shiftKey,
  isComposing = false,
}: {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
}): boolean {
  return key === "Enter" && !shiftKey && !isComposing;
}

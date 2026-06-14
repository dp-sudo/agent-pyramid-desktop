import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

export interface UsePanelResizerOptions {
  width: number;
  onWidthChange: (next: number) => void;
  applyDragDelta: (startWidth: number, clientX: number, startX: number) => number;
  onDraggingChange?: (dragging: boolean) => void;
}

interface ActiveDrag {
  target: HTMLElement;
  onMove: (event: PointerEvent) => void;
  clearDragListeners: () => void;
}

export function usePanelResizer(options: UsePanelResizerOptions): {
  dragging: boolean;
  handlePointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
} {
  const {
    width,
    onWidthChange,
    applyDragDelta,
    onDraggingChange,
  } = options;
  const [dragging, setDragging] = useState(false);
  const activeDragRef = useRef<ActiveDrag | null>(null);
  const onDraggingChangeRef = useRef(onDraggingChange);

  useEffect(() => {
    onDraggingChangeRef.current = onDraggingChange;
  }, [onDraggingChange]);

  const clearActiveDrag = useCallback((): void => {
    const activeDrag = activeDragRef.current;
    if (!activeDrag) return;
    activeDragRef.current = null;
    activeDrag.target.removeEventListener("pointermove", activeDrag.onMove);
    activeDrag.target.removeEventListener("pointerup", activeDrag.clearDragListeners);
    activeDrag.target.removeEventListener("pointercancel", activeDrag.clearDragListeners);
    setDragging(false);
    onDraggingChangeRef.current?.(false);
  }, []);

  useEffect(() => clearActiveDrag, [clearActiveDrag]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    clearActiveDrag();
    const startX = event.clientX;
    const startWidth = width;
    const target = event.currentTarget;
    const onMove = (moveEvent: PointerEvent): void => {
      onWidthChange(applyDragDelta(startWidth, moveEvent.clientX, startX));
    };
    const clearDragListeners = (): void => {
      clearActiveDrag();
    };

    activeDragRef.current = {
      target,
      onMove,
      clearDragListeners,
    };
    setDragging(true);
    onDraggingChangeRef.current?.(true);
    target.setPointerCapture(event.pointerId);
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", clearDragListeners);
    target.addEventListener("pointercancel", clearDragListeners);
  }, [
    applyDragDelta,
    clearActiveDrag,
    onWidthChange,
    width,
  ]);

  return { dragging, handlePointerDown };
}

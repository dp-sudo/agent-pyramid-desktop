import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export interface ComposerPopoverState {
  shellRef: RefObject<HTMLDivElement | null>;
  menuOpen: boolean;
  pickerOpen: boolean;
  closePopovers(): void;
  closeMenu(): void;
  toggleMenu(): void;
  togglePicker(): void;
}

export function useComposerPopovers(): ComposerPopoverState {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const closePopovers = useCallback((): void => {
    setMenuOpen(false);
    setPickerOpen(false);
  }, []);

  useEffect(() => {
    if (!menuOpen && !pickerOpen) return undefined;

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (shellRef.current?.contains(target)) return;
      closePopovers();
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        closePopovers();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closePopovers, menuOpen, pickerOpen]);

  return {
    shellRef,
    menuOpen,
    pickerOpen,
    closePopovers,
    closeMenu: useCallback(() => setMenuOpen(false), []),
    toggleMenu: useCallback(() => {
      setMenuOpen((value) => !value);
      setPickerOpen(false);
    }, []),
    togglePicker: useCallback(() => {
      setPickerOpen((value) => !value);
      setMenuOpen(false);
    }, []),
  };
}

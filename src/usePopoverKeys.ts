// usePopoverKeys — the keyboard side shared by the row popovers
// (ProjectMenu / ReminderMenu / HideMenu). Opening a menu moves focus into
// it, so the keyboard that opened it keeps working: ↑/↓ move the highlight
// (clamped, like the palette and search menus), Enter activates it, and
// where a menu has a create field (ProjectMenu) the first printable key
// lands there. The row underneath keeps its App-state focus the whole time —
// the menu borrows the keystrokes, not the focus grammar: App's handler
// stands down while a popover is open, and Escape is each menu's own
// document-level closer, so one Esc closes the menu and leaves the row
// focused.

import { useEffect, useRef, useState } from "react";

export function usePopoverKeys({
  open,
  menuRef,
  count,
  initialIndex,
  onPick,
  onType,
}: {
  open: boolean;
  menuRef: React.RefObject<HTMLElement | null>;
  count: number;
  // Where the highlight starts each open — the caller's natural row (the
  // currently assigned project, say). A function so it reads fresh state at
  // open time, not the previous render's.
  initialIndex: () => number;
  onPick: (index: number) => void;
  // Absent on menus without a create field; present, the first printable
  // key routes into it (native insertion is prevented — the caller appends).
  onType?: (char: string) => void;
}) {
  const [hi, setHi] = useState(0);
  const initial = useRef(initialIndex);
  initial.current = initialIndex;

  useEffect(() => {
    if (!open) return;
    setHi(initial.current());
    menuRef.current?.focus();
  }, [open, menuRef]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // The menu's own inputs (create field, date picker) own their keys —
    // typing, the native caret, Escape bubbling to the document closer.
    if ((e.target as HTMLElement)?.tagName === "INPUT") return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(0, Math.min(count - 1, h + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (count > 0) onPick(hi);
    } else if (onType && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      onType(e.key);
    }
  };

  return { hi, setHi, onKeyDown };
}

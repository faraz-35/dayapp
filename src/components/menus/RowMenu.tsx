// RowMenu — the shared shell of the four identical row popovers (Project /
// Priority / Reminder / Hide): the ◐-style trigger button, the anchored
// .hide-menu container, the outside-click/Escape close, the viewport flip,
// and the keyboard (usePopoverKeys — ↑/↓ move the highlight, Enter picks,
// a printable key routes to `onType`'s field). One implementation of the
// "identical row affordances" AGENTS.md documents; each menu file owns only
// its rows and what a pick does.
//
// The pick contract: a pick CLOSES the menu and fires POPOVER_PICK_EVENT so
// the grammar stands down to nothing-focused — the keystroke after a pick
// was aimed at the menu and must never fire the row. Menu bodies call
// `close()` (which does both) inside their pick handlers.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { trace } from "../../logging/devlog";
import { firePopoverPick } from "../../keyboard/focusNav";
import { usePopoverFlip } from "./usePopoverFlip";
import { usePopoverKeys } from "./usePopoverKeys";

export default function RowMenu({
  kb, label, icon, traceName,
  count, initialIndex, onPick, onType,
  children,
}: {
  kb?: string;
  /** The trigger's title + aria-label ("Set priority", "Hide", …). */
  label: string;
  icon: ReactNode;
  /** The popover.open trace's menu name. */
  traceName: string;
  // ---- usePopoverKeys passthrough -------------------------------------
  count: number;
  initialIndex: () => number;
  /** Enter's pick — receives `close` so keyboard picks follow the same
   *  contract as click picks. */
  onPick: (i: number, close: () => void) => void;
  onType?: (ch: string) => void;
  /** The menu's rows, fed the keyboard highlight. */
  children: (kb: { hi: number; setHi: (i: number) => void; close: () => void }) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const flip = usePopoverFlip(open, ref, menuRef);

  // Close on outside click or Escape (from anywhere inside — a create
  // field's keys bubble to this document listener).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    firePopoverPick();
  };

  const { hi, setHi, onKeyDown } = usePopoverKeys({
    open,
    menuRef,
    count,
    initialIndex,
    onPick: (i: number) => onPick(i, close),
    onType,
  });

  return (
    <div className="hide-menu-wrap" ref={ref}>
      <button
        className="item-action"
        data-kb={kb}
        onClick={(e) => {
          e.stopPropagation();
          if (!open) trace("popover.open", { menu: traceName });
          setOpen(!open);
        }}
        title={label}
        aria-label={label}
        aria-expanded={open}
      >{icon}</button>
      {open && (
        <div
          className={`hide-menu${flip ? " flip" : ""}`}
          ref={menuRef}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          onClick={(e) => e.stopPropagation()}
        >
          {children({ hi, setHi, close })}
        </div>
      )}
    </div>
  );
}

// HideMenu — minimal popover for picking a hide duration. Shared by item rows
// and notes so both surfaces get the identical affordance.
//
// A ◐ trigger button opens a small anchored menu with the four durations. The
// menu closes on selection, Escape, or an outside click. All pointer events
// stopPropagation so opening it never selects a row, starts a drag, or focuses
// a note textarea.
//
// Keyboard (usePopoverKeys): the open menu holds focus — ↑/↓ move the
// highlight, Enter hides. One Escape closes back onto the row/note, which
// never lost its focus.

import { useEffect, useRef, useState } from "react";
import type { HideDuration } from "./lib";
import { usePopoverFlip } from "./usePopoverFlip";
import { usePopoverKeys } from "./usePopoverKeys";

const OPTIONS: { id: HideDuration; label: string; sub: string }[] = [
  { id: "forever", label: "Forever", sub: "until unhidden" },
  { id: "day", label: "For a day", sub: "until tomorrow" },
  { id: "week", label: "For a week", sub: "until next week" },
  { id: "month", label: "For a month", sub: "until next month" },
];

export default function HideMenu({ onHide, kb }: { onHide: (duration: HideDuration) => void; kb?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const flip = usePopoverFlip(open, ref, menuRef);

  // Close on outside click or Escape (from anywhere inside).
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

  const { hi, setHi, onKeyDown } = usePopoverKeys({
    open,
    menuRef,
    count: OPTIONS.length,
    initialIndex: () => 0,
    onPick: (i) => {
      setOpen(false);
      onHide(OPTIONS[i].id);
    },
  });

  return (
    <div className="hide-menu-wrap" ref={ref}>
      <button
        className="item-action"
        data-kb={kb}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title="Hide"
        aria-label="Hide"
        aria-expanded={open}
      >◐</button>
      {open && (
        <div
          className={`hide-menu${flip ? " flip" : ""}`}
          ref={menuRef}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          onClick={(e) => e.stopPropagation()}
        >
          {OPTIONS.map((o, i) => (
            <button
              key={o.id}
              className={`hide-menu-item${hi === i ? " hi" : ""}`}
              onMouseEnter={() => setHi(i)}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onHide(o.id);
              }}
            >
              <span className="hide-menu-label">{o.label}</span>
              <span className="hide-menu-sub">{o.sub}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

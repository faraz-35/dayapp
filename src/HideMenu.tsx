// HideMenu — minimal popover for picking a hide duration. Shared by item rows
// and notes so both surfaces get the identical affordance.
//
// A ◐ trigger button opens a small anchored menu with the four durations. The
// menu closes on selection, Escape, or an outside click. All pointer events
// stopPropagation so opening it never selects a row, starts a drag, or focuses
// a note textarea.

import { useEffect, useRef, useState } from "react";
import type { HideDuration } from "./lib";

const OPTIONS: { id: HideDuration; label: string; sub: string }[] = [
  { id: "forever", label: "Forever", sub: "until unhidden" },
  { id: "day", label: "For a day", sub: "until tomorrow" },
  { id: "week", label: "For a week", sub: "until next week" },
  { id: "month", label: "For a month", sub: "until next month" },
];

export default function HideMenu({ onHide }: { onHide: (duration: HideDuration) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape.
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

  return (
    <div className="hide-menu-wrap" ref={ref}>
      <button
        className="item-action"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title="Hide"
        aria-label="Hide"
        aria-expanded={open}
      >◐</button>
      {open && (
        <div className="hide-menu" onClick={(e) => e.stopPropagation()}>
          {OPTIONS.map((o) => (
            <button
              key={o.id}
              className="hide-menu-item"
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

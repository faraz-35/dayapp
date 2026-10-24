// PriorityMenu — minimal popover for setting (or clearing) an item's priority
// tier. Mirrors ProjectMenu/ReminderMenu so all the row affordances feel
// identical.
//
// A bars trigger opens a small anchored menu: the three tiers (P1 first — the
// filled count grows with urgency) and a divider, then "No priority" to clear
// (ReminderMenu's clear-last shape). The menu closes on selection, Escape, or
// an outside click. All pointer events stopPropagation so opening it never
// selects a row, starts a drag, or focuses a note textarea.
//
// Keyboard (usePopoverKeys): the open menu holds focus — ↑/↓ move the
// highlight (it starts on the current tier), Enter picks. One Escape closes
// back onto the row, which never lost its focus. A pick goes further: it fires
// POPOVER_PICK_EVENT so the grammar stands down to nothing-focused — the
// keystroke after a pick was aimed at the menu and must never fire the row.

import { useEffect, useRef, useState } from "react";
import { trace } from "./devlog";
import { firePopoverPick } from "./focusNav";
import { usePopoverFlip } from "./usePopoverFlip";
import { usePopoverKeys } from "./usePopoverKeys";
import { IconBars } from "./components/icons";

const TIERS: (1 | 2 | 3)[] = [1, 2, 3];

export default function PriorityMenu({
  priority, onSet, kb,
}: {
  priority: 1 | 2 | 3 | null;
  onSet: (priority: 1 | 2 | 3 | null) => void;
  kb?: string;
}) {
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

  const pick = (v: 1 | 2 | 3 | null) => {
    trace("priority.set", { priority: v });
    setOpen(false);
    firePopoverPick();
    onSet(v);
  };

  // Rows: the three tiers, then No priority. The highlight opens on the
  // current tier.
  const { hi, setHi, onKeyDown } = usePopoverKeys({
    open,
    menuRef,
    count: TIERS.length + 1,
    initialIndex: () => (priority ? priority - 1 : TIERS.length),
    onPick: (i) => pick(i < TIERS.length ? TIERS[i] : null),
  });

  return (
    <div className="hide-menu-wrap" ref={ref}>
      <button
        className="item-action"
        data-kb={kb}
        onClick={(e) => {
          e.stopPropagation();
          if (!open) trace("popover.open", { menu: "priority" });
          setOpen(!open);
        }}
        title="Set priority"
        aria-label="Set priority"
        aria-expanded={open}
      ><IconBars /></button>
      {open && (
        <div
          className={`hide-menu${flip ? " flip" : ""}`}
          ref={menuRef}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          onClick={(e) => e.stopPropagation()}
        >
          {TIERS.map((t, i) => (
            <button
              key={t}
              className={`hide-menu-item${hi === i ? " hi" : ""}`}
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(t)}
            >
              <span className="hide-menu-label">Priority {t}</span>
              <span className="hide-menu-sub">{t === priority ? "✓" : ""}</span>
            </button>
          ))}
          <div className="hide-menu-divider" />
          <button
            className={`hide-menu-item${hi === TIERS.length ? " hi" : ""}`}
            onMouseEnter={() => setHi(TIERS.length)}
            onClick={() => pick(null)}
          >
            <span className="hide-menu-label">No priority</span>
            <span className="hide-menu-sub">{priority === null ? "✓" : ""}</span>
          </button>
        </div>
      )}
    </div>
  );
}

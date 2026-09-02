// ReminderMenu — minimal popover for scheduling a backlog item to auto-promote
// to Today on a future date. Mirrors HideMenu/ProjectMenu so all three row
// affordances feel identical.
//
// A ◷ trigger opens a small anchored menu with date presets, a date picker, and
// (when a reminder is set) a Clear option. The promotion itself is silent and
// fires on the day-boundary sweep / app launch — no macOS notification (that
// would need entitlements). Reminders are date-granular, not time-of-day.
//
// Keyboard (usePopoverKeys): the open menu holds focus — ↑/↓ move the
// highlight across the presets (and Clear, when set), Enter picks. One Escape
// closes back onto the row. The date input stays native: Tab reaches it and
// its keys are its own (the hook leaves input-targeted events alone).

import { useEffect, useRef, useState } from "react";
import { localDateStrOffset } from "./lib";
import { trace } from "./devlog";
import { usePopoverFlip } from "./usePopoverFlip";
import { usePopoverKeys } from "./usePopoverKeys";

const PRESETS: { days: number; label: string }[] = [
  { days: 1, label: "Tomorrow" },
  { days: 3, label: "In 3 days" },
  { days: 7, label: "In a week" },
];

export default function ReminderMenu({
  remindAt, onSet, kb,
}: {
  remindAt: string | null;
  onSet: (remindAt: string | null) => void;
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

  const pick = (v: string | null) => {
    trace("reminder.set", { remind: v });
    setOpen(false);
    onSet(v);
  };

  // The presets, plus Clear when a reminder is set — the picker's keyboard rows.
  const count = PRESETS.length + (remindAt ? 1 : 0);
  const { hi, setHi, onKeyDown } = usePopoverKeys({
    open,
    menuRef,
    count,
    initialIndex: () => 0,
    onPick: (i) => pick(i < PRESETS.length ? localDateStrOffset(PRESETS[i].days) : null),
  });

  return (
    <div className="hide-menu-wrap" ref={ref}>
      <button
        className="item-action"
        data-kb={kb}
        onClick={(e) => {
          e.stopPropagation();
          if (!open) trace("popover.open", { menu: "reminder" });
          setOpen(!open);
        }}
        title="Remind me"
        aria-label="Remind me"
        aria-expanded={open}
      >◷</button>
      {open && (
        <div
          className={`hide-menu${flip ? " flip" : ""}`}
          ref={menuRef}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          onClick={(e) => e.stopPropagation()}
        >
          {PRESETS.map((p, i) => (
            <button
              key={p.days}
              className={`hide-menu-item${hi === i ? " hi" : ""}`}
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(localDateStrOffset(p.days))}
            >
              <span className="hide-menu-label">{p.label}</span>
              <span className="hide-menu-sub">{localDateStrOffset(p.days)}</span>
            </button>
          ))}
          <div className="hide-menu-divider" />
          <input
            type="date"
            className="menu-input"
            value={remindAt ?? localDateStrOffset(1)}
            onChange={(e) => pick(e.target.value || null)}
            onClick={(e) => e.stopPropagation()}
            title="Pick a date"
          />
          {remindAt && (
            <>
              <div className="hide-menu-divider" />
              <button
                className={`hide-menu-item${hi === count - 1 ? " hi" : ""}`}
                onMouseEnter={() => setHi(count - 1)}
                onClick={() => pick(null)}
              >
                <span className="hide-menu-label">Clear reminder</span>
                <span className="hide-menu-sub">{remindAt}</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ReminderMenu — the reminder rows: date presets, a native date picker, and
// (when a reminder is set) a Clear option. The promotion itself is silent and
// fires on the day-boundary sweep / app launch — no macOS notification (that
// would need entitlements). Reminders are date-granular, not time-of-day.
// The date input stays native: Tab reaches it and its keys are its own (the
// shell's keyboard leaves input-targeted events alone).

import { trace } from "../../logging/devlog";
import RowMenu from "./RowMenu";
import { IconClock } from "../icons";
import { todayOffset } from "../../lib/dates";

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
  const pick = (v: string | null, close: () => void) => {
    trace("reminder.set", { remind: v });
    close();
    onSet(v);
  };

  // The presets, plus Clear when a reminder is set — the picker's keyboard rows.
  const count = PRESETS.length + (remindAt ? 1 : 0);

  return (
    <RowMenu
      kb={kb}
      label="Remind me"
      icon={<IconClock />}
      traceName="reminder"
      count={count}
      initialIndex={() => 0}
      onPick={(i, close) => pick(i < PRESETS.length ? todayOffset(PRESETS[i].days) : null, close)}
    >
      {({ hi, setHi, close }) => (
        <>
          {PRESETS.map((p, i) => (
            <button
              key={p.days}
              className={`hide-menu-item${hi === i ? " hi" : ""}`}
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(todayOffset(p.days), close)}
            >
              <span className="hide-menu-label">{p.label}</span>
              <span className="hide-menu-sub">{todayOffset(p.days)}</span>
            </button>
          ))}
          <div className="hide-menu-divider" />
          <input
            type="date"
            className="menu-input"
            value={remindAt ?? todayOffset(1)}
            onChange={(e) => pick(e.target.value || null, close)}
            onClick={(e) => e.stopPropagation()}
            title="Pick a date"
          />
          {remindAt && (
            <>
              <div className="hide-menu-divider" />
              <button
                className={`hide-menu-item${hi === count - 1 ? " hi" : ""}`}
                onMouseEnter={() => setHi(count - 1)}
                onClick={() => pick(null, close)}
              >
                <span className="hide-menu-label">Clear reminder</span>
                <span className="hide-menu-sub">{remindAt}</span>
              </button>
            </>
          )}
        </>
      )}
    </RowMenu>
  );
}

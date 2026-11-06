// PriorityMenu — the tier rows: P1 → P3 (the filled count grows with
// urgency), a divider, then "No priority" to clear (ReminderMenu's
// clear-last shape). The highlight opens on the current tier. The shell
// (RowMenu) owns the trigger, the anchoring, the close, and the keyboard.

import { trace } from "../../logging/devlog";
import RowMenu from "./RowMenu";
import { IconBars } from "../icons";

const TIERS: (1 | 2 | 3)[] = [1, 2, 3];

export default function PriorityMenu({
  priority, onSet, kb,
}: {
  priority: 1 | 2 | 3 | null;
  onSet: (priority: 1 | 2 | 3 | null) => void;
  kb?: string;
}) {
  const pick = (v: 1 | 2 | 3 | null, close: () => void) => {
    trace("priority.set", { priority: v });
    close();
    onSet(v);
  };

  return (
    <RowMenu
      kb={kb}
      label="Set priority"
      icon={<IconBars />}
      traceName="priority"
      // Rows: the three tiers, then No priority.
      count={TIERS.length + 1}
      initialIndex={() => (priority ? priority - 1 : TIERS.length)}
      onPick={(i, close) => pick(i < TIERS.length ? TIERS[i] : null, close)}
    >
      {({ hi, setHi, close }) => (
        <>
          {TIERS.map((t, i) => (
            <button
              key={t}
              className={`hide-menu-item${hi === i ? " hi" : ""}`}
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(t, close)}
            >
              <span className="hide-menu-label">Priority {t}</span>
              <span className="hide-menu-sub">{t === priority ? "✓" : ""}</span>
            </button>
          ))}
          <div className="hide-menu-divider" />
          <button
            className={`hide-menu-item${hi === TIERS.length ? " hi" : ""}`}
            onMouseEnter={() => setHi(TIERS.length)}
            onClick={() => pick(null, close)}
          >
            <span className="hide-menu-label">No priority</span>
            <span className="hide-menu-sub">{priority === null ? "✓" : ""}</span>
          </button>
        </>
      )}
    </RowMenu>
  );
}

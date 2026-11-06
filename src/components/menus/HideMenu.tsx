// HideMenu — the hide-duration rows: the four options of the soft-archive.
// Shared by item rows and notes; `verb` carries the surface's word ("Hide",
// or "Pause" on Daily rows — same mechanism, different name for a recurring
// habit). The shell (RowMenu) owns the trigger, the anchoring, the close,
// and the keyboard.

import RowMenu from "./RowMenu";
import { IconHalfMoon } from "../icons";
import { HideDuration } from "../../types/item";

const OPTIONS: { id: HideDuration; label: string; sub: string }[] = [
  { id: "forever", label: "Forever", sub: "until unhidden" },
  { id: "day", label: "For a day", sub: "until tomorrow" },
  { id: "week", label: "For a week", sub: "until next week" },
  { id: "month", label: "For a month", sub: "until next month" },
];

export default function HideMenu({ onHide, kb, verb = "Hide" }: { onHide: (duration: HideDuration) => void; kb?: string; verb?: "Hide" | "Pause" }) {
  const pick = (duration: HideDuration, close: () => void) => {
    close();
    onHide(duration);
  };

  return (
    <RowMenu
      kb={kb}
      label={verb}
      icon={<IconHalfMoon />}
      traceName="hide"
      count={OPTIONS.length}
      initialIndex={() => 0}
      onPick={(i, close) => pick(OPTIONS[i].id, close)}
    >
      {({ hi, setHi, close }) =>
        OPTIONS.map((o, i) => (
          <button
            key={o.id}
            className={`hide-menu-item${hi === i ? " hi" : ""}`}
            onMouseEnter={() => setHi(i)}
            onClick={(e) => {
              e.stopPropagation();
              pick(o.id, close);
            }}
          >
            <span className="hide-menu-label">{o.label}</span>
            <span className="hide-menu-sub">{o.id === "forever" && verb === "Pause" ? "until unpaused" : o.sub}</span>
          </button>
        ))
      }
    </RowMenu>
  );
}

// KeyboardHelp — the reference card for the keyboard focus grammar
// (⌘P → Keyboard Shortcuts). A floating surface like the palette: fixed
// backdrop + card, Escape or click-outside closes. Pure documentation;
// nothing here executes. The grammar itself lives in App.tsx's key handler
// and src/focusNav.ts. Rows are existence-aware (Settings → Features): a
// switched-off axis's rows drop, digit ranges compact, and the address
// schemes degrade exactly like the live grammar (b[1-9] without task
// priorities, n[1-9] without note priorities).

import { useEffect } from "react";
import { useFeatures } from "./features";

function Row({ keys, children }: { keys: string[]; children: React.ReactNode }) {
  return (
    <div className="help-row">
      <span className="help-keys">
        {keys.map((k) => <kbd key={k}>{k}</kbd>)}
      </span>
      <span className="help-desc">{children}</span>
    </div>
  );
}

export default function KeyboardHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const features = useFeatures();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const p = features.projects;
  const tp = features.taskPriorities;
  const np = features.notePriorities;
  const ag = features.agent;
  const tm = features.timer;
  const rm = features.reminders;
  const hi = features.hide;

  // The task-row digit range: however many buttons render, left to right.
  const taskDigits = 1
    + (tm ? 1 : 0)
    + (p ? 1 : 0)
    + (rm ? 1 : 0)
    + (hi ? 1 : 0)
    + 1 /* details */
    + 1; /* delete */
  const goalDigits = 2 + (p ? 1 : 0);
  const taskVerbList = [
    ...(tm ? ["▶ timer (Backlog: ↑ send to Today)"] : []),
    ...(p ? ["# project"] : []),
    ...(rm ? ["◷ remind"] : []),
    ...(hi ? ["◐ hide"] : []),
    "⋯ details",
    "× delete",
  ].join(" · ");
  const goalVerbList = ["✓ achieve", ...(p ? ["# project"] : []), "× delete"].join(" · ");
  const popoverList = [
    ...(p ? ["# project"] : []),
    ...(rm ? ["◷ remind"] : []),
    ...(hi ? ["◐ hide"] : []),
  ].join(" / ");

  return (
    <div className="help-backdrop" onClick={onClose}>
      <div className="help" onClick={(e) => e.stopPropagation()}>
        <div className="help-title">Keyboard</div>

        <div className="help-section">Focus an address</div>
        <Row keys={["nn"]}>focus the Notes capture</Row>
        {features.quotes && (
          <Row keys={["nj"]}>Notes capture with a journal / quote route typed for you</Row>
        )}
        {features.today && features.daily && features.backlog && (
          <Row keys={["nt", "nd", "nb"]}>
            the task capture — ##t / ##d / ##b (Today / Daily / Backlog) typed for you; bare text lands in Today</Row>
        )}
        <Row keys={["t1–9", ...(features.tasks ? ["d1–9"] : [])]}>focus a Today / Daily row</Row>
        <Row keys={[tp ? "b11–49" : "b1–9"]}>
          focus a Backlog row{tp ? " — tier 4 is unprioritized" : " (flat — priorities are off)"}</Row>
        <Row keys={[np ? "n11–49" : "n1–9"]}>
          focus a note{np ? " — tier digit first (4 = unmarked), row within the tier" : " (flat — priorities are off)"}</Row>
        {features.goals && <Row keys={["g1–9"]}>focus a goal</Row>}

        <div className="help-section">Act on the focused thing</div>
        <Row keys={[`1–${taskDigits}`]}>task: {taskVerbList}</Row>
        <Row keys={["1–4"]}>note: ⌃ expand · ⬇ download .txt{hi ? " · ◐ hide" : ""} · × delete</Row>
        {features.goals && <Row keys={[`1–${goalDigits}`]}>goal: {goalVerbList}</Row>}
        {(p || rm || hi) && (
          <Row keys={["↑", "↓", "Enter"]}>inside an open popover ({popoverList}): move · pick — a pick clears focus, Esc returns to the row{p ? " · typing in # creates" : ""}</Row>
        )}
        <Row keys={["e"]}>edit it</Row>
        <Row keys={["Enter"]}>complete the focused task</Row>

        <div className="help-section">Move / leave</div>
        <Row keys={["j", "k", "↑", "↓"]}>next / previous task · nothing focused: scroll the list</Row>
        <Row keys={["Esc"]}>find bar → editing → focused → nothing — digits do nothing unfocused</Row>

        <div className="help-section">Everywhere</div>
        <Row keys={["⌘P", "⌘F"]}>
          command palette · search{p || ag ? ` (${[...(p ? ["# project filter"] : []), ...(ag ? ["@ agent/my"] : [])].join(", ")})` : ""}
          {features.notes ? " — ⌘F while editing a note: find in that note" : ""}
        </Row>
        <Row keys={["⌘+", "⌘-", "⌘0"]}>zoom in / out / reset</Row>
      </div>
    </div>
  );
}

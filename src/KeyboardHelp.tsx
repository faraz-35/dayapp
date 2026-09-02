// KeyboardHelp — the reference card for the keyboard focus grammar
// (⌘P → Keyboard Shortcuts). A floating surface like the palette: fixed
// backdrop + card, Escape or click-outside closes. Pure documentation;
// nothing here executes. The grammar itself lives in App.tsx's key handler
// and src/focusNav.ts.

import { useEffect } from "react";

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
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="help-backdrop" onClick={onClose}>
      <div className="help" onClick={(e) => e.stopPropagation()}>
        <div className="help-title">Keyboard</div>

        <div className="help-section">Focus an address</div>
        <Row keys={["nn"]}>focus the Notes capture</Row>
        <Row keys={["nj", "nq"]}>Notes capture with a journal / quote route typed for you</Row>
        <Row keys={["nt", "nd", "nb"]}>the task capture — ##t / ##d / ##b (Today / Daily / Backlog) typed for you; bare text lands in Today</Row>
        <Row keys={["t1–9", "d1–9"]}>focus a Today / Daily row</Row>
        <Row keys={["b11–49"]}>focus a Backlog row — tier 4 is unprioritized</Row>
        <Row keys={["n11–49"]}>focus a note — tier digit first (4 = unmarked), row within the tier</Row>
        <Row keys={["g1–9"]}>focus a goal</Row>

        <div className="help-section">Act on the focused thing</div>
        <Row keys={["1–6"]}>task: ▶ timer (Backlog: ↑ send to Today) · # project · ◷ remind · ◐ hide · ⋯ details · × delete</Row>
        <Row keys={["1–4"]}>note: ⌃ expand · ⬇ download .txt · ◐ hide · × delete</Row>
        <Row keys={["1–3"]}>goal: ✓ achieve · # project · × delete</Row>
        <Row keys={["↑", "↓", "Enter"]}>inside an open popover (# project / ◷ remind / ◐ hide): move · pick — typing in # creates · Esc returns to the row</Row>
        <Row keys={["e"]}>edit it</Row>
        <Row keys={["Enter"]}>complete the focused task</Row>

        <div className="help-section">Move / leave</div>
        <Row keys={["j", "k", "↑", "↓"]}>next / previous task · nothing focused: scroll the list</Row>
        <Row keys={["Esc"]}>find bar → editing → focused → nothing — digits do nothing unfocused</Row>

        <div className="help-section">Everywhere</div>
        <Row keys={["⌘P", "⌘F"]}>command palette · search (⌘F while editing a note: find in that note)</Row>
        <Row keys={["⌘+", "⌘-", "⌘0"]}>zoom in / out / reset</Row>
      </div>
    </div>
  );
}

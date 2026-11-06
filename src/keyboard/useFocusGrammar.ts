// useFocusGrammar — the focus grammar's key handler and its one-focused-thing
// machinery, extracted whole from App: the address sequences (nn/nj/nq/nt/nd/
// nb, t/d/b/g rows), the j/k walk across goals → notes → tasks, the Esc
// ladder, the digits that fire the focused thing's buttons, and the mouse's
// matching rules (click-to-focus, outside-click clear, the popover-pick
// stand-down). App owns the focus STATE (selectedId / focusNoteId /
// focusGoalId render the highlight); this hook owns the keyboard and pointer
// behavior over it. See AGENTS.md "Keyboard — the focus grammar".

import { useCallback, useEffect, useRef } from "react";
import { clip, trace } from "../logging/devlog";
import { todayStr } from "../lib/dates";
import type { Item, Section } from "../types/item";
import { clickKbButton, focusCapture, focusGoalEditor, focusNoteEditor, goalIdAt, noteIdAt, POPOVER_PICK_EVENT, popoverOpen, scrollIntoViewEl } from "./focusNav";
import type { View } from "../components/Header";

// The address prefixes of the focus grammar: n (notes + captures), t/d
// (Today/Daily rows), b (Backlog rows, two digits: tier then index), g
// (goals). Typed directly, no mode.
const ADDRESS_KEYS = new Set(["n", "t", "d", "b", "g"]);

// Free-mode scroll step (px) for j/k + ↑/↓ when nothing is focused. Read in
// .scroll's local space, so zoom scales it with the content — the step is
// always ~4 rows regardless of zoom level.
const SCROLL_STEP = 120;

export interface FocusGrammarDeps {
  view: View;
  setView: (v: View) => void;
  selectedId: string | null;
  focusNoteId: string | null;
  focusGoalId: string | null;
  setSelectedId: (id: string | null) => void;
  setFocusNoteId: (id: string | null) => void;
  setFocusGoalId: (id: string | null) => void;
  setEditingId: (id: string | null) => void;
  setQuoteOpen: (open: boolean) => void;
  renderItems: Record<Section, Item[]>;
  allVisible: Item[];
  handleComplete: (id: string, section: Section) => void;
  helpOpen: boolean;
  syncSettingsOpen: boolean;
  paletteOpen: boolean;
  searchOpen: boolean;
  updateStatus: unknown;
  quoteOpen: boolean;
  journalEnabled: boolean;
  quotesEnabled: boolean;
  notePrioritiesEnabled: boolean;
  taskPrioritiesEnabled: boolean;
  sectionsEnabled: Record<Section, boolean>;
}

export function useFocusGrammar(deps: FocusGrammarDeps) {
  const {
    view, setView, selectedId, focusNoteId, focusGoalId,
    setSelectedId, setFocusNoteId, setFocusGoalId, setEditingId, setQuoteOpen,
    renderItems, allVisible, handleComplete,
    helpOpen, syncSettingsOpen, paletteOpen, searchOpen, updateStatus, quoteOpen,
    journalEnabled, quotesEnabled, notePrioritiesEnabled, taskPrioritiesEnabled,
    sectionsEnabled,
  } = deps;

  // The half-typed address. Nothing renders from it; the handler consumes
  // exactly one following key (`b` re-arms once for its tier digit). Modifier
  // combos and leaving the list view cancel it.
  const pendingAddr = useRef("");

  const clearFocus = useCallback(() => {
    setSelectedId(null);
    setFocusNoteId(null);
    setFocusGoalId(null);
  }, []);

  // A popover pick stands the grammar down to nothing-focused: the menu that
  // absorbed the keystrokes just unmounted, and the row underneath must not
  // stay Enter-armed (see POPOVER_PICK_EVENT in focusNav.ts). Esc and
  // outside-click are the walk-backs and keep the row focused.
  useEffect(() => {
    const onPopoverPick = () => {
      trace("focus.clear", { via: "popover-pick" });
      clearFocus();
    };
    document.addEventListener(POPOVER_PICK_EVENT, onPopoverPick);
    return () => document.removeEventListener(POPOVER_PICK_EVENT, onPopoverPick);
  }, [clearFocus]);

  // Outside-click is the mouse's walk from focused to nothing: a press that
  // lands outside every focusable surface (any row, note, or goal) clears
  // grammar focus — clicking another row instead lands its own focus. The
  // focused row's open details body counts as inside (digit 5 opens it; the
  // row keeps focus while it writes). While a popover is open the press
  // belongs to the menu's own walk-back — it closes onto the still-focused
  // row — so this stands down for that press.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (selectedId === null && focusNoteId === null && focusGoalId === null) return;
      if (popoverOpen()) return;
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest("[data-item-id], [data-note-id], [data-goal-id]")) return;
      if (selectedId !== null) {
        const row = document.querySelector(`[data-item-id="${selectedId}"]`);
        const body = row?.nextElementSibling;
        if (body?.classList.contains("item-details") && body.contains(t)) return;
      }
      trace("focus.clear", { via: "outside-click" });
      clearFocus();
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [selectedId, focusNoteId, focusGoalId, clearFocus]);

  const focusItem = useCallback((id: string) => {
    setSelectedId(id);
    setFocusNoteId(null);
    setFocusGoalId(null);
    scrollIntoViewEl(document.querySelector(`[data-item-id="${id}"]`));
  }, []);

  const focusNote = useCallback((id: string) => {
    setSelectedId(null);
    setFocusGoalId(null);
    setFocusNoteId(id);
    scrollIntoViewEl(document.querySelector(`[data-note-id="${id}"]`));
  }, []);

  const focusGoal = useCallback((id: string) => {
    setSelectedId(null);
    setFocusNoteId(null);
    setFocusGoalId(id);
    scrollIntoViewEl(document.querySelector(`[data-goal-id="${id}"]`));
  }, []);

  // Resolve a complete address sequence. Row indexes come from renderItems
  // (filters and toggled-off sections compose for free); notes and goals come
  // from the DOM (Notes/Goals own their lists — DOM order is visual order).
  // An address that lands nowhere (t9 with three rows) is a silent no-op.
  const resolveAddress = (seq: string) => {
    const [p, a, b] = seq;
    const n = Number(a);
    if (p === "n") {
      if (a === "n") { trace("capture.focus", { address: seq, target: "notes" }); focusCapture("notes"); }
      // nj/nq only when the destination exists (Settings → Features) — an
      // address into a switched-off surface is a silent no-op, like t9 into
      // an empty section.
      else if (a === "j" && journalEnabled) { trace("capture.focus", { address: seq, target: "notes", route: "##j" }); focusCapture("notes", "##j"); }
      else if (a === "q" && quotesEnabled) { trace("capture.focus", { address: seq, target: "notes", route: "##q" }); focusCapture("notes", "##q"); }
      else if (a === "t" && sectionsEnabled.today) { trace("capture.focus", { address: seq, target: "tasks", route: "##t" }); focusCapture("tasks", "##t"); }
      else if (a === "d" && sectionsEnabled.daily) { trace("capture.focus", { address: seq, target: "tasks", route: "##d" }); focusCapture("tasks", "##d"); }
      else if (a === "b" && sectionsEnabled.backlog) { trace("capture.focus", { address: seq, target: "tasks", route: "##b" }); focusCapture("tasks", "##b"); }
      else if (n >= 1 && n <= 9) {
        // Note priorities off → the flat n[1-9] scheme: the digit is the row.
        // On → the tier-row scheme (tier digit 4 = unmarked, then the row).
        if (!notePrioritiesEnabled) {
          const id = noteIdAt(null, n);
          if (id) { focusNote(id); trace("focus.note", { via: "address", address: seq, id }); }
          else trace("focus.miss", { address: seq });
          return;
        }
        const idx = Number(b);
        if (!(idx >= 1 && idx <= 9)) {
          // Tier digit in, index still coming — hold the sequence open.
          pendingAddr.current = seq;
          return;
        }
        const tier = n === 4 ? null : (n as 1 | 2 | 3);
        const id = noteIdAt(tier, idx);
        if (id) { focusNote(id); trace("focus.note", { via: "address", address: seq, id }); }
        else trace("focus.miss", { address: seq });
      }
    } else if ((p === "t" || p === "d") && n >= 1 && n <= 9) {
      const item = renderItems[p === "t" ? "today" : "daily"][n - 1];
      if (item) { focusItem(item.id); trace("focus.task", { via: "address", address: seq, id: item.id }); }
      else trace("focus.miss", { address: seq });
    } else if (p === "g" && n >= 1 && n <= 9) {
      const id = goalIdAt(n);
      if (id) { focusGoal(id); trace("focus.goal", { via: "address", address: seq, id }); }
      else trace("focus.miss", { address: seq });
    } else if (p === "b" && n >= 1 && n <= 9) {
      // Task priorities off → flat b[1-9] over the Backlog's rendered order.
      if (!taskPrioritiesEnabled) {
        const item = renderItems.backlog[n - 1];
        if (item) { focusItem(item.id); trace("focus.task", { via: "address", address: seq, id: item.id }); }
        else trace("focus.miss", { address: seq });
        return;
      }
      const idx = Number(b);
      if (!(idx >= 1 && idx <= 9)) {
        // Tier digit in, index still coming — hold the sequence open.
        pendingAddr.current = seq;
        return;
      }
      const tier = n === 4 ? null : (n as 1 | 2 | 3);
      const item = renderItems.backlog.filter((i) => (i.priority ?? null) === tier)[idx - 1];
      if (item) { focusItem(item.id); trace("focus.task", { via: "address", address: seq, id: item.id }); }
      else trace("focus.miss", { address: seq });
    }
  };

  // The mouse follows the same one-focused-thing rule as the grammar:
  // clicking a row, note, or goal makes it the digits' target, exactly as
  // addressing it would. Clicks elsewhere leave focus alone — Esc is the
  // explicit way down the ladder.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      const noteId = el?.closest("[data-note-id]")?.getAttribute("data-note-id");
      if (noteId) {
        setSelectedId(null); setFocusGoalId(null); setFocusNoteId(noteId);
        trace("focus.note", { via: "click", id: noteId });
        return;
      }
      const goalId = el?.closest("[data-goal-id]")?.getAttribute("data-goal-id");
      if (goalId) {
        setSelectedId(null); setFocusNoteId(null); setFocusGoalId(goalId);
        trace("focus.goal", { via: "click", id: goalId });
        return;
      }
      const itemId = el?.closest("[data-item-id]")?.getAttribute("data-item-id");
      if (itemId) {
        setFocusNoteId(null); setFocusGoalId(null); setSelectedId(itemId);
        trace("focus.task", { via: "click", id: itemId });
      }
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // A floating surface owns the keys while it's open. Its focused input
      // already covered typing; this also catches a blurred input behind a
      // backdrop and freezes the page under the update overlay's swap.
      if (helpOpen || syncSettingsOpen || paletteOpen || searchOpen || updateStatus) {
        pendingAddr.current = "";
        return;
      }
      // The quote modal owns the keys while it's open — it has no inputs, so
      // any key means "done thinking" and dismisses (see the grace notes
      // inside).
      if (quoteOpen) {
        pendingAddr.current = "";
        // Bare modifier chords are prefixes (⌘P/⌘F still work via their own
        // listener) and don't dismiss. Every other key does.
        const chordPrefix = e.metaKey || e.ctrlKey || e.altKey || e.key === "Shift";
        if (!chordPrefix) {
          e.preventDefault();
          setQuoteOpen(false);
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) {
        pendingAddr.current = "";
        return;
      }
      const target = e.target as HTMLElement;
      const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA";

      if (typing) return;

      // An open row popover (project / reminder / hide) owns the keyboard:
      // focus lives inside its menu (usePopoverKeys drives ↑/↓/Enter there),
      // so this grammar must not act on the row underneath it. One Esc on
      // that surface closes the menu — each popover's own document listener —
      // and the row's focus survives, because nothing here runs to clear it.
      if (popoverOpen()) {
        pendingAddr.current = "";
        return;
      }

      // A pending address consumes exactly the next key — the first key of
      // the sequence already cleared focus, so a digit here can never fire a
      // button on the thing that had it.
      const addr = pendingAddr.current;
      if (addr) {
        e.preventDefault();
        pendingAddr.current = "";
        resolveAddress(addr + e.key);
        return;
      }

      // j/k + ↑/↓: with something focused they walk the rows (clamped at
      // the ends — Esc or a new address is the only way out of focus mode).
      // With nothing focused — the Esc ladder's bottom rung — they scroll
      // the page instead: a view-only verb, so free mode gains a use
      // without anything being able to happen unseen. Works in every view
      // (the analytics page has no focusable rows).
      const down = e.key === "j" || e.key === "ArrowDown";
      const up = e.key === "k" || e.key === "ArrowUp";
      if (down || up) {
        e.preventDefault();
        if (selectedId === null && focusNoteId === null && focusGoalId === null) {
          // Held keys auto-repeat; one scrolled page isn't N interactions.
          if (!e.repeat) trace("scroll", { key: e.key });
          document.querySelector(".scroll")?.scrollBy({
            top: down ? SCROLL_STEP : -SCROLL_STEP,
            behavior: "smooth",
          });
        } else {
          moveSelection(down ? 1 : -1);
        }
        return;
      }

      // The settings page's back door: Esc is "done here" (nothing on the
      // page is ever focused — the grammar below never runs on it).
      if (e.key === "Escape" && view === "settings") {
        trace("view.switch", { view: "list" });
        setView("list");
        return;
      }

      if (view !== "list") {
        pendingAddr.current = "";
        return;
      }

      if (e.key === "Enter" && selectedId) {
        const item = allVisible.find((i) => i.id === selectedId);
        // Archived rows aren't actionable — completing one would silently
        // vanish it (done + hidden, invisible in every mode). Unhide first.
        if (item && !item.hidden) {
          e.preventDefault();
          // A done Daily carries status "active" — its done-state is today's
          // completion record, same test handleComplete toggles on.
          const unchecking =
            item.status === "done" ||
            (item.section === "daily" && item.lastCompletedDate === todayStr());
          trace(unchecking ? "uncomplete" : "complete", { via: "enter", text: clip(item.text), section: item.section });
          handleComplete(item.id, item.section);
        }
      } else if (e.key === "e") {
        // The one edit verb, on whichever thing is focused.
        if (selectedId) { e.preventDefault(); trace("edit.start", { via: "e", subject: "task" }); setEditingId(selectedId); }
        else if (focusNoteId) { e.preventDefault(); trace("edit.start", { via: "e", subject: "note" }); focusNoteEditor(focusNoteId); }
        else if (focusGoalId) { e.preventDefault(); trace("edit.start", { via: "e", subject: "goal" }); focusGoalEditor(focusGoalId); }
      } else if (e.key === "Escape") {
        // Ladder rung focused → nothing. (editing → focused is each edit
        // surface's own Escape — cancel/flush and blur, landing on the thing
        // still focused here. An open popover is a higher rung, handled by
        // the gate above.)
        trace("focus.clear");
        clearFocus();
      } else if (/^[1-9]$/.test(e.key)) {
        // Fire the focused thing's Nth button (data-kb markers, visual
        // order). Nothing focused → nothing happens, by design.
        const scope = selectedId
          ? document.querySelector(`[data-item-id="${selectedId}"]`)
          : focusNoteId
            ? document.querySelector(`[data-note-id="${focusNoteId}"]`)
            : focusGoalId
              ? document.querySelector(`[data-goal-id="${focusGoalId}"]`)
              : null;
        if (scope) { e.preventDefault(); clickKbButton(scope, Number(e.key)); }
      } else if (ADDRESS_KEYS.has(e.key)) {
        // Address prefix. Clears focus first — the user's safety rule — then
        // waits for the one or two keys that complete it.
        e.preventDefault();
        clearFocus();
        pendingAddr.current = e.key;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allVisible, selectedId, focusNoteId, focusGoalId, view, helpOpen, syncSettingsOpen, paletteOpen, searchOpen, quoteOpen, updateStatus, renderItems]);

  // The j/k walk spans the page's addressable rows in visual order — goal
  // rows (DOM order; Goals owns the list), then notes, then the task rows.
  // A focused goal, note, and row are one walk: focus crosses the surfaces
  // and clamps at the page's ends, never dropping.
  const moveSelection = (delta: number) => {
    const attrs = (attr: string) => Array.from(document.querySelectorAll(`[${attr}]`))
      .map((el) => el.getAttribute(attr) ?? "")
      .filter(Boolean);
    const noteIds = attrs("data-note-id");
    const goalIds = attrs("data-goal-id");
    const walk = [...goalIds, ...noteIds, ...allVisible.map((i) => i.id)];
    const cur = focusGoalId ?? focusNoteId ?? selectedId;
    const idx = walk.indexOf(cur ?? "");
    const next = idx === -1
      ? (delta > 0 ? 0 : walk.length - 1)
      : Math.min(walk.length - 1, Math.max(0, idx + delta));
    const id = walk[next] ?? null;
    // Only real moves act — a held key clamped at an end is one position,
    // not a stream of no-ops.
    if (!id || id === cur) return;
    trace("focus.step", { to: id, dir: delta > 0 ? "next" : "prev" });
    if (goalIds.includes(id)) focusGoal(id);
    else if (noteIds.includes(id)) focusNote(id);
    else focusItem(id);
  };
}

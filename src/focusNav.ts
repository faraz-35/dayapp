// focusNav — the DOM side of the keyboard focus grammar (⌘P → Keyboard
// Shortcuts documents it end to end). Addresses are typed directly, no mode:
// `t3` focuses the third Today row, `b21` the first P2 Backlog row, `nn` the
// notes capture. Once something is focused (a row, a note, or a goal — App
// holds that state), digits fire its buttons through their data-kb markers,
// so a hover button and its digit share the one real onClick handler. These
// helpers only find rendered elements and drive them: DOM order is visual
// order, so filters and toggled-off surfaces simply have no indexes.

// Fire the focused thing's Nth button. false when the button doesn't render —
// a digit past the row's count, or the row is mid-edit and its actions are
// unmounted.
export function clickKbButton(scope: Element | null, n: number): boolean {
  const btn = scope?.querySelector(`[data-kb="${n}"]`);
  if (!(btn instanceof HTMLElement)) return false;
  btn.click();
  return true;
}

// The route prefill: `nj`/`nq` focus the notes capture and `nt`/`nd`/`nb` the
// task capture, each with its leading ##x token already swapped in.
// focusCapture dispatches this event on the field; TokenField (with `route`
// set) hears it and rewrites the value.
export const ROUTE_EVENT = "dayapp-route";

// Focus a capture input by address (`nn`/`nj`/`nq` the notes bar, the last
// two with their route pre-swapped; `nt`/`nd`/`nb` the ONE task capture with
// its ##t/##d/##b route — there are no per-section inputs anymore). false
// when the surface isn't rendered — its input isn't in the DOM.
export function focusCapture(which: "notes" | "tasks", route?: string): boolean {
  const el = document.querySelector(`[data-capture="${which}"]`);
  if (!(el instanceof HTMLElement)) return false;
  el.focus();
  if (route) el.dispatchEvent(new CustomEvent<string>(ROUTE_EVENT, { detail: route }));
  return true;
}

// The nth rendered note/goal by id (1-based; past 9 doesn't address — j/k and
// ⌘F still reach long lists).
export function noteIdAt(n: number): string | null {
  return document.querySelectorAll("[data-note-id]")[n - 1]?.getAttribute("data-note-id") ?? null;
}

export function goalIdAt(n: number): string | null {
  return document.querySelectorAll("[data-goal-id]")[n - 1]?.getAttribute("data-goal-id") ?? null;
}

// The `e` verb on a focused note. A collapsed card expands through its own
// click handler (which drops the caret at the end of the textarea); an open
// one takes the caret directly.
export function focusNoteEditor(id: string): void {
  const card = document.querySelector(`[data-note-id="${id}"]`);
  if (!(card instanceof HTMLElement)) return;
  if (card.classList.contains("collapsed")) {
    card.click();
    return;
  }
  const ta = card.querySelector("textarea");
  if (!(ta instanceof HTMLTextAreaElement)) return;
  ta.focus();
  const end = ta.value.length;
  ta.setSelectionRange(end, end);
}

// The `e` verb on a focused goal — the row's click enters edit mode and the
// shared EditInput autofocuses with the caret at the end.
export function focusGoalEditor(id: string): void {
  const row = document.querySelector(`[data-goal-id="${id}"]`);
  if (row instanceof HTMLElement) row.click();
}

// A duration/project/reminder popover open? While it lasts it holds keyboard
// focus itself (usePopoverKeys) and the grammar stands down — the menu's own
// document listener closes it on Escape, one press, with the row still
// focused underneath.
export function popoverOpen(): boolean {
  return document.querySelector(".hide-menu") !== null;
}

// After a React commit lands the newly focused element, bring it on screen.
export function scrollIntoViewEl(el: Element | null): void {
  requestAnimationFrame(() => el?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
}

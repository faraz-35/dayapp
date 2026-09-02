// Quotes — the ##q moment. One quote, deliberately summoned (⌘P → Show a
// Quote): a dim backdrop with a single centered serif-italic line and nothing
// else. The modal is quotes' one surface — the old always-on rotating line
// under the header became wallpaper (a quote always in view stops being
// read; Faraz's call, 2026-08-26), so now a quote appears only when asked
// for, holds the screen for a quiet moment, and goes.
//
// The exception that proves the rule: the screensaver. Two minutes of
// focused stillness and App's idle watcher summons this same modal unprompted
// — the one sanctioned auto-invocation, because it arrives only in *absence*
// (never interrupts) and lingers until input instead of LINGER_MS (a
// screensaver that dismisses itself into blank idleness defeats itself).
//
// Dismissal is the point: any key or click ends it (App's global handler
// owns that — the modal has no inputs, so every key means "done thinking"),
// or LINGER_MS passes on a ⌘P summon and it dismisses itself. The pick never
// repeats the last-shown quote (the masthead brand rotation's rule, reused).
//
// Self-contained like Notes/Goals: App owns only the open boolean (the
// floating-surface gate in its key handler needs it) and the refresh
// trigger — `version` bumps on demo-mode swaps and whenever a ##q capture
// lands, so the pool is always current without polling. The pool size rides
// `onCount` up to App so the ⌘P entries can hide while there's nothing to
// summon (quotes have no management surface — no pool, no entries).

import { useEffect, useRef, useState } from "react";
import { entriesApi, type Entry } from "./lib";
import { log } from "./log";
import { trace } from "./devlog";

// How long a summoned moment holds the screen before dismissing itself. A
// default, not a rule — any key or click ends it sooner.
const LINGER_MS = 45_000;

export default function Quotes({
  version = 0,
  open = false,
  lingerForever = false,
  onClose,
  onCount,
}: {
  /** Refresh trigger: bumps on demo swaps and ##q captures (App-owned). */
  version?: number;
  /** App's render flag — the modal exists only while true. */
  open?: boolean;
  /** Screensaver opens never end themselves — the moment lasts until a key
      or click, not a timer. ⌘P summons keep the LINGER_MS self-dismissal. */
  lingerForever?: boolean;
  onClose: () => void;
  /** Reports the pool size up so App can hide the ⌘P entries when empty. */
  onCount?: (n: number) => void;
}) {
  const [quotes, setQuotes] = useState<Entry[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  // The quote shown before this one — the next pick avoids it, so summons
  // shuffle rather than dice-roll repeats (lastTheme's rule).
  const lastText = useRef<string | null>(null);

  useEffect(() => {
    entriesApi.list()
      .then((all) => {
        const pool = all.filter((e) => e.kind === "quote");
        setQuotes(pool);
        onCount?.(pool.length);
      })
      .catch((e) => log.error("quotes load failed", e));
  }, [version, onCount]);

  // Summoning picks: a random quote that isn't the last one shown. `quotes`
  // may still be loading when open lands first — the effect re-runs when it
  // arrives, so the pick happens either way.
  useEffect(() => {
    if (!open || quotes.length === 0) return;
    const pool = quotes.filter((q) => q.text !== lastText.current);
    const from = pool.length > 0 ? pool : quotes;
    const pick = from[Math.floor(Math.random() * from.length)];
    lastText.current = pick.text;
    setCurrent(pick.text);
  }, [open, quotes]);

  // A ⌘P summon ends itself after LINGER_MS — an unattended modal shouldn't
  // hold the screen forever. The screensaver's open is the opposite case: it
  // arrived *because* nothing is happening, so it outlives the timer and
  // waits for input (App's dismissal handler). Key/click dismissal comes
  // from App's handler either way.
  useEffect(() => {
    if (!open || lingerForever) return;
    const id = setTimeout(() => {
      trace("quote.dismiss", { via: "linger" });
      onClose();
    }, LINGER_MS);
    return () => clearTimeout(id);
  }, [open, lingerForever, onClose]);

  if (!open || current == null) return null;

  return (
    <div className="quote-backdrop" onClick={() => { trace("quote.dismiss", { via: "click" }); onClose(); }}>
      {/* Keyed so every summon remounts the span and fades the quote in —
          the masthead's quiet-ident trick, reused. */}
      <span className="quote-text" key={current}>{current}</span>
    </div>
  );
}

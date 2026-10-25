// Quotes — the ##q moment. One quote on a dim backdrop: a single centered
// serif-italic line and nothing else. The modal's only open path is the
// screensaver (App's idle watcher): two minutes of focused stillness and it
// arrives — never on a clock, never interrupting, because it only shows up
// when nothing is happening. The deliberate surface is the Quotes page (❝ /
// ⌘P → View Quotes); ⌘P → Show a Quote and the screensaver toggle retired
// 2026-09-15, so no self-timer exists here anymore — every open is
// idle-born and lingers until input.
//
// Dismissal is the point: any key or click ends it (App's global handler
// owns that — the modal has no inputs, so every key means "done thinking").
// The pick never repeats the last-shown quote (the masthead brand rotation's
// rule, reused).
//
// Self-contained like Notes/Goals: App owns only the open boolean (the
// floating-surface gate in its key handler needs it) and the refresh
// trigger — `version` bumps on demo-mode swaps and whenever a ##q capture
// lands, so the pool is always current without polling. The pool size rides
// `onCount` up to App so the idle watcher can skip an empty pool. The pool's
// archive lives on the Quotes page; this modal stays the moment, not the list.

import { useEffect, useRef, useState } from "react";
import { entriesApi } from "./lib";
import { log } from "./log";
import { trace } from "./devlog";

// The pool's floor — one quote ships with the app (2026-10-25), so the
// screensaver works before the first ##q lands. Chrome like the masthead
// words: it rides the rotation but never enters the entries table, so the
// Quotes page stays the archive of what you captured. A capture of the same
// line dedups the built-in copy out.
const BUILT_IN_QUOTES = [
  "There is nothing so useless as doing efficiently that which should not be done at all.",
];

export default function Quotes({
  version = 0,
  open = false,
  onClose,
  onCount,
}: {
  /** Refresh trigger: bumps on demo swaps and ##q captures (App-owned). */
  version?: number;
  /** App's render flag — the modal exists only while true. */
  open?: boolean;
  onClose: () => void;
  /** Reports the pool size up so App's idle watcher can skip an empty pool. */
  onCount?: (n: number) => void;
}) {
  const [quotes, setQuotes] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  // The quote shown before this one — the next pick avoids it, so summons
  // shuffle rather than dice-roll repeats (lastTheme's rule).
  const lastText = useRef<string | null>(null);

  useEffect(() => {
    entriesApi.list()
      .then((all) => {
        const captured = all.filter((e) => e.kind === "quote").map((e) => e.text);
        const pool = [...captured, ...BUILT_IN_QUOTES.filter((t) => !captured.includes(t))];
        setQuotes(pool);
        onCount?.(pool.length);
      })
      .catch((e) => log.error("quotes load failed", e));
  }, [version, onCount]);

  // Summoning picks: a random quote that isn't the last one shown, from the
  // captured ##q entries plus the built-in floor. `quotes` may still be
  // loading when open lands first — the effect re-runs when it arrives, so
  // the pick happens either way.
  useEffect(() => {
    if (!open) return;
    const all = quotes;
    if (all.length === 0) return;
    const pool = all.filter((q) => q !== lastText.current);
    const from = pool.length > 0 ? pool : all;
    const pick = from[Math.floor(Math.random() * from.length)];
    lastText.current = pick;
    setCurrent(pick);
  }, [open, quotes]);

  if (!open || current == null) return null;

  return (
    <div className="quote-backdrop" onClick={() => { trace("quote.dismiss", { via: "click" }); onClose(); }}>
      {/* Keyed so every summon remounts the span and fades the quote in —
          the masthead's quiet-ident trick, reused. */}
      <span className="quote-text" key={current}>{current}</span>
    </div>
  );
}

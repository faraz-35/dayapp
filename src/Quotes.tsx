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
import { entriesApi, type Entry } from "./lib";
import { log } from "./log";
import { trace } from "./devlog";

// Fun Mode's pool — app-owned chrome, the masthead's FUN_MASTHEAD_THEMES
// move one layer down. The lens drops pressure everywhere, so while it's on
// these stand in for the captured quotes instead of mixing with them: a
// heavy quote from the real pool would break the register. Turn the lens
// off and the ##q pool comes back untouched.
const FUN_QUOTES = [
  "Slow is fine. Slow is still going.",
  "Nothing you finish today has to be perfect. It just has to exist.",
  "You can do anything for five minutes.",
  "Done badly is still done.",
  "The list will be here tomorrow. You don't have to be.",
  "Small steps still leave footprints.",
  "You are not behind. You are just early for later.",
  "Rest counts as work. It's the work that makes the rest of it possible.",
  "Start sloppy. Fix it when it's fun again.",
  "One thing. Just pick one thing.",
  "The tab you keep meaning to read will forgive you.",
  "Today was a day. That's all it had to be.",
];

export default function Quotes({
  version = 0,
  open = false,
  funMode = false,
  onClose,
  onCount,
}: {
  /** Refresh trigger: bumps on demo swaps and ##q captures (App-owned). */
  version?: number;
  /** App's render flag — the modal exists only while true. */
  open?: boolean;
  /** Fun Mode's lens — while on, picks come from FUN_QUOTES, not the pool. */
  funMode?: boolean;
  onClose: () => void;
  /** Reports the pool size up so App's idle watcher can skip an empty pool. */
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
        onCount?.(funMode ? Math.max(pool.length, 1) : pool.length);
      })
      .catch((e) => log.error("quotes load failed", e));
  }, [version, funMode, onCount]);

  // Summoning picks: a random quote that isn't the last one shown. Under
  // Fun Mode the pool is FUN_QUOTES (never empty); otherwise the captured
  // ##q entries. `quotes` may still be loading when open lands first — the
  // effect re-runs when it arrives, so the pick happens either way.
  useEffect(() => {
    if (!open) return;
    const all = funMode
      ? FUN_QUOTES.map((text) => ({ text }))
      : quotes;
    if (all.length === 0) return;
    const pool = all.filter((q) => q.text !== lastText.current);
    const from = pool.length > 0 ? pool : all;
    const pick = from[Math.floor(Math.random() * from.length)];
    lastText.current = pick.text;
    setCurrent(pick.text);
  }, [open, quotes, funMode]);

  if (!open || current == null) return null;

  return (
    <div className="quote-backdrop" onClick={() => { trace("quote.dismiss", { via: "click" }); onClose(); }}>
      {/* Keyed so every summon remounts the span and fades the quote in —
          the masthead's quiet-ident trick, reused. */}
      <span className="quote-text" key={current}>{current}</span>
    </div>
  );
}

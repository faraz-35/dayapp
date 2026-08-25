// Quotes — the ##q carousel line. A single calm block of serif italic directly
// under the header, above Notes and everything else: one quote at a time,
// rotating every 2 minutes (never the same one twice in a row — the masthead
// brand rotation's rule, same cadence), each swap fading in through the same
// `title-in` keyframes. The quote wraps — ~75% width, centered, as many lines
// as it needs (never ellipsized).
//
// "Carousel" in the minimal sense Faraz specified: different quotes appear at
// different times. No dots, no controls, no chrome — the line simply exists
// while quotes exist, and renders nothing at all when the pool is empty.
//
// Self-contained like Notes/Goals (own fetch + rotation), but App owns the
// refresh trigger: `version` bumps on demo-mode swaps and whenever a ##q
// capture lands in Notes, so the pool is always current without polling.

import { useEffect, useRef, useState } from "react";
import { entriesApi, type Entry } from "./lib";
import { log } from "./log";

// Same cadence as the masthead brand rotation — one quiet change per 2 minutes.
const ROTATE_MS = 120_000;

export default function Quotes({ version = 0 }: { version?: number }) {
  const [quotes, setQuotes] = useState<Entry[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  // The quote shown before the current stretch — the next pick avoids it, so
  // the rotation shuffles rather than dice-rolls repeats (lastTheme's rule).
  const lastText = useRef<string | null>(null);

  useEffect(() => {
    entriesApi.list()
      .then((all) => setQuotes(all.filter((e) => e.kind === "quote")))
      .catch((e) => log.error("quotes load failed", e));
  }, [version]);

  // Rotation: every 2 minutes pick a random quote that isn't the one on
  // screen. With ≤1 quote there is nothing to rotate to — the line is static
  // and the timer stays cheap (the pick is a no-op).
  useEffect(() => {
    const id = setInterval(() => {
      setCurrent((prev) => {
        const pool = quotes.filter((q) => q.text !== prev);
        if (pool.length === 0) return prev;
        const pick = pool[Math.floor(Math.random() * pool.length)];
        lastText.current = pick.text;
        return pick.text;
      });
    }, ROTATE_MS);
    return () => clearInterval(id);
  }, [quotes]);

  // A new pool: keep the on-screen quote if it survived (captures don't
  // interrupt the stretch), otherwise pick fresh from what's there.
  useEffect(() => {
    if (quotes.length === 0) {
      setCurrent(null);
      return;
    }
    setCurrent((prev) => {
      if (prev && quotes.some((q) => q.text === prev)) return prev;
      const pool = quotes.filter((q) => q.text !== lastText.current);
      const from = pool.length > 0 ? pool : quotes;
      const pick = from[Math.floor(Math.random() * from.length)];
      lastText.current = pick.text;
      return pick.text;
    });
  }, [quotes]);

  if (current == null) return null;

  return (
    <div className="quote-line">
      {/* Keyed so every rotation remounts the span and fades the new quote
          in — the masthead's quiet-ident trick, reused. */}
      <span className="quote-text" key={current}>{current}</span>
    </div>
  );
}

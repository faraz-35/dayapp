// SearchMenu — ⌘F item search. A floating modal (mirrors the ⌘P command
// palette): a dim backdrop with a centered card holding the input + a list of
// matches. ↑/↓ moves the selection; Enter jumps to the item in the list
// (scrolls it into view, selects it) and closes; Esc closes.
//
// Deliberately NOT an inline/sticky bar — inline chrome pushes content and
// "feels inline." Floating it via position:fixed + backdrop makes it read as a
// transient surface, the same mental model as the command palette.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Item, Section } from "../lib";

export interface SearchHit {
  item: Item;
  section: Section;
}

export default function SearchMenu({
  open, hits, onClose, onJump,
}: {
  open: boolean;
  hits: SearchHit[];
  onClose: () => void;
  onJump: (hit: SearchHit) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset to a clean state every time the menu opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // Focus on next tick so the input is mounted.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Filter hits by the query (case-insensitive substring on the item text).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return hits;
    return hits.filter((h) => h.item.text.toLowerCase().includes(q));
  }, [query, hits]);

  // Keep the active row in range as the filter narrows.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  // Scroll the active row into view inside the list.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const jump = (hit?: SearchHit) => {
    const h = hit ?? filtered[active];
    if (!h) return;
    onJump(h);
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      jump();
    }
  };

  return (
    <div className="search-backdrop" onClick={onClose}>
      <div className="search" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder="Search items…"
          spellCheck={false}
        />
        <div className="search-list" ref={listRef}>
          {filtered.length === 0 && (
            <div className="search-empty">No matches.</div>
          )}
          {filtered.map((h, i) => (
            <button
              key={h.item.id}
              data-idx={i}
              className={`search-row${i === active ? " active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => jump(h)}
            >
              <span className="search-row-section">{h.section}</span>
              <span className="search-row-text">{h.item.text}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

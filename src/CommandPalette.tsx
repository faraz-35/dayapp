// CommandPalette — ⌘P modal, VS Code / Linear style. A filterable list of
// commands with arrow-key navigation. The command set is passed in by the
// parent so the palette stays a dumb, reusable surface.
//
// Keys: ↑/↓ to move, Enter to run, Esc to close. Clicking a row runs
// it. The list filters by label (case-insensitive substring) and auto-selects
// the first match.

import { useEffect, useMemo, useRef, useState } from "react";
import { trace } from "./devlog";

export interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export default function CommandPalette({
  open, commands, onClose,
}: {
  open: boolean;
  commands: Command[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Open/close land here (not in App's ⌘P handler) so every door to the
  // palette — key, or any future one — traces identically.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) trace("palette.open");
    else if (!open && wasOpen.current) trace("palette.close");
    wasOpen.current = open;
  }, [open]);

  // Reset to a clean state every time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // Focus on next tick so the input is mounted.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [query, commands]);

  // Keep the active row in range as the filter changes.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  // Scroll the active row into view when it moves.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const run = (cmd?: Command) => {
    const c = cmd ?? filtered[active];
    if (!c) return;
    trace("palette.exec", { command: c.id, label: c.label });
    c.run();
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
      run();
    }
  };

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          spellCheck={false}
        />
        <div className="palette-list" ref={listRef}>
          {filtered.length === 0 && (
            <div className="palette-empty">No matching commands.</div>
          )}
          {filtered.map((cmd, i) => (
            <button
              key={cmd.id}
              data-idx={i}
              className={`palette-row${i === active ? " active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(cmd)}
            >
              <span className="palette-label">{cmd.label}</span>
              {cmd.hint && <span className="palette-hint">{cmd.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

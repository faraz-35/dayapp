// SearchMenu — ⌘F search. A floating modal (mirrors the ⌘P command
// palette): a dim backdrop with a centered card holding the input + the hit
// list. ↑/↓ moves the selection; Enter acts on it and closes; Esc closes.
//
// Deliberately NOT an inline/sticky bar — inline chrome pushes content and
// "feels inline." Floating it via position:fixed + backdrop makes it read as
// a transient surface, the same mental model as the command palette.
//
// Two modes over one surface: the default searches items (Enter jumps to the
// row — scrolls it into view, selects it). A query starting with `#` flips
// the list to the projects (narrowed by the text after the `#`), and Enter
// filters the main list to that project — or clears the filter when that
// project is already the active one. The `#` mirrors the capture field's
// project tag, so the same token both assigns and filters.

import { useEffect, useMemo, useRef, useState } from "react";
import { projectColor, type Item, type Project, type Section } from "../lib";

export interface SearchHit {
  item: Item;
  section: Section;
}

export default function SearchMenu({
  open, hits, projects, activeProjectId, onClose, onJump, onSelectProject,
}: {
  open: boolean;
  hits: SearchHit[];
  projects: Project[];
  activeProjectId: string | null;
  onClose: () => void;
  onJump: (hit: SearchHit) => void;
  onSelectProject: (projectId: string) => void;
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

  // A leading `#` flips the list from item hits to projects.
  const projectMode = query.trimStart().startsWith("#");

  // Filter hits by the query (case-insensitive substring on the item text).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return hits;
    return hits.filter((h) => h.item.text.toLowerCase().includes(q));
  }, [query, hits]);

  // In `#` mode the query after the `#` narrows the project names.
  const filteredProjects = useMemo(() => {
    const q = query.trimStart().slice(1).trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.name.toLowerCase().includes(q));
  }, [query, projects]);

  // Whichever mode's list is on screen, so the index handling below (bounds,
  // keyboard nav, scroll) is mode-agnostic.
  const rows = projectMode ? filteredProjects : filtered;

  // Start at the top when the mode flips (`#` typed or deleted)…
  useEffect(() => { setActive(0); }, [projectMode]);
  // …and keep the active row in range as the filter narrows.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, rows.length - 1)));
  }, [rows.length]);

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

  const selectProject = (project?: Project) => {
    const p = project ?? filteredProjects[active];
    if (!p) return;
    onSelectProject(p.id);
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (projectMode) selectProject();
      else jump();
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
          placeholder="Search items… (# to filter by project)"
          spellCheck={false}
        />
        <div className="search-list" ref={listRef}>
          {rows.length === 0 && (
            <div className="search-empty">{projectMode ? "No projects." : "No matches."}</div>
          )}
          {projectMode ? filteredProjects.map((p, i) => (
            <button
              key={p.id}
              data-idx={i}
              className={`search-row${i === active ? " active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => selectProject(p)}
            >
              <span className="search-dot" style={{ background: projectColor(p.id) }} />
              <span className="search-row-text">{p.name}</span>
              {p.id === activeProjectId && <span className="search-row-hint">filtered</span>}
            </button>
          )) : filtered.map((h, i) => (
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

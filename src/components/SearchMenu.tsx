// SearchMenu — ⌘F search. A floating modal (mirrors the ⌘P command
// palette): a dim backdrop with a centered card holding the input + the hit
// list. ↑/↓ moves the selection; Enter acts on it and closes; Esc closes.
//
// Deliberately NOT an inline/sticky bar — inline chrome pushes content and
// "feels inline." Floating it via position:fixed + backdrop makes it read as
// a transient surface, the same mental model as the command palette.
//
// Two picker modes over one surface: the default searches items (Enter jumps
// to the row — scrolls it into view, selects it). A query starting with `#`
// flips the list to the projects (narrowed by the text after the `#`), and
// Enter filters the main list to that project — or clears the filter when that
// project is already the active one. The `#` mirrors the capture field's
// project tag, so the same token both assigns and filters. A query starting
// with `@` works the same way over the delegation axis: "Agent tasks" narrows
// to the 🤖-marked queue, "My tasks" to the unmarked rows. `@` mirrors the
// capture field's agent token — same token, assign and filter.

import { useEffect, useMemo, useRef, useState } from "react";
import { projectColor, type Item, type Project, type Section } from "../lib";

export interface SearchHit {
  item: Item;
  section: Section;
}

/** The `@` picker's two fixed entries. id doubles as App's agentFilter value. */
const AGENT_FILTERS = [
  { id: "agent", label: "🤖 Agent tasks" },
  { id: "mine", label: "My tasks" },
] as const;

export default function SearchMenu({
  open, hits, projects, activeProjectId, activeAgentFilter, onClose, onJump, onSelectProject, onSelectAgent,
}: {
  open: boolean;
  hits: SearchHit[];
  projects: Project[];
  activeProjectId: string | null;
  activeAgentFilter: "agent" | "mine" | null;
  onClose: () => void;
  onJump: (hit: SearchHit) => void;
  onSelectProject: (projectId: string) => void;
  onSelectAgent: (mode: "agent" | "mine") => void;
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

  // A leading `#` flips the list from item hits to projects; `@` to the
  // agent/my executor picker.
  const projectMode = query.trimStart().startsWith("#");
  const agentMode = !projectMode && query.trimStart().startsWith("@");

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

  // Same narrowing over the `@` picker's two fixed labels.
  const filteredAgents = useMemo(() => {
    const q = query.trimStart().slice(1).trim().toLowerCase();
    if (!q) return AGENT_FILTERS;
    return AGENT_FILTERS.filter((f) => f.label.toLowerCase().includes(q));
  }, [query]);

  // Whichever mode's list is on screen, so the index handling below (bounds,
  // keyboard nav, scroll) is mode-agnostic.
  const rows = agentMode ? filteredAgents : projectMode ? filteredProjects : filtered;

  // Start at the top when the mode flips (`#`/`@` typed or deleted)…
  useEffect(() => { setActive(0); }, [projectMode, agentMode]);
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

  const selectAgent = (mode?: (typeof AGENT_FILTERS)[number]) => {
    const f = mode ?? filteredAgents[active];
    if (!f) return;
    onSelectAgent(f.id);
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
      if (agentMode) selectAgent();
      else if (projectMode) selectProject();
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
          placeholder="Search items… (# project filter, @ agent/my)"
          spellCheck={false}
        />
        <div className="search-list" ref={listRef}>
          {rows.length === 0 && (
            <div className="search-empty">{projectMode ? "No projects." : "No matches."}</div>
          )}
          {agentMode ? filteredAgents.map((f, i) => (
            <button
              key={f.id}
              data-idx={i}
              className={`search-row${i === active ? " active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => selectAgent(f)}
            >
              <span className="search-row-text">{f.label}</span>
              {f.id === activeAgentFilter && <span className="search-row-hint">filtered</span>}
            </button>
          )) : projectMode ? filteredProjects.map((p, i) => (
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

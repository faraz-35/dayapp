// ProjectMenu — minimal popover for assigning (or clearing) an item's project.
// Mirrors HideMenu so both affordances feel identical.
//
// A # trigger button opens a small anchored menu listing existing projects (the
// current one marked), a "No project" option to clear, and an inline input to
// create-and-assign a new project. The menu closes on selection, Escape, or an
// outside click. All pointer events stopPropagation so opening it never selects
// a row, starts a drag, or focuses a note textarea.

import { useEffect, useRef, useState } from "react";
import { projectsApi, type Project } from "./lib";

export default function ProjectMenu({
  projectId, onAssign,
}: {
  projectId: string | null;
  onAssign: (projectId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  // Load projects on first open. Cheap (personal-scale list) and keeps the
  // menu fresh if projects changed elsewhere without a full app refresh.
  useEffect(() => {
    if (!open) return;
    projectsApi.list().then(setProjects).catch(() => setProjects([]));
  }, [open]);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const assign = (id: string | null) => {
    setOpen(false);
    setDraft("");
    onAssign(id);
  };

  const createAndAssign = async () => {
    const name = draft.trim();
    if (!name) return;
    try {
      const p = await projectsApi.create(name);
      assign(p.id);
    } catch {
      // leave menu open on failure so the user can retry
    }
  };

  return (
    <div className="hide-menu-wrap" ref={ref}>
      <button
        className="item-action"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title="Set project"
        aria-label="Set project"
        aria-expanded={open}
      >#</button>
      {open && (
        <div className="hide-menu" onClick={(e) => e.stopPropagation()}>
          <button
            className="hide-menu-item"
            onClick={() => assign(null)}
          >
            <span className="hide-menu-label">No project</span>
            <span className="hide-menu-sub">{projectId === null ? "✓" : ""}</span>
          </button>
          {projects.map((p) => (
            <button
              key={p.id}
              className="hide-menu-item"
              onClick={() => assign(p.id)}
            >
              <span className="hide-menu-label">{p.name}</span>
              <span className="hide-menu-sub">{p.id === projectId ? "✓" : ""}</span>
            </button>
          ))}
          <div className="hide-menu-divider" />
          <input
            className="menu-input"
            value={draft}
            autoFocus
            placeholder="New project…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") createAndAssign();
            }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}

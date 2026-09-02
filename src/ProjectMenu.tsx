// ProjectMenu — minimal popover for assigning (or clearing) an item's project.
// Mirrors HideMenu so both affordances feel identical.
//
// A # trigger button opens a small anchored menu listing existing projects (the
// current one marked), a "No project" option to clear, and an inline input to
// create-and-assign a new project. The menu closes on selection, Escape, or an
// outside click. All pointer events stopPropagation so opening it never selects
// a row, starts a drag, or focuses a note textarea.
//
// Keyboard (usePopoverKeys): the open menu holds focus — ↑/↓ move the
// highlight (it starts on the current project), Enter assigns it, and any
// printable key lands in the create field. One Escape closes back onto the
// row, which never lost its focus.
//
// The list and creation come from the parent (App's projects state): the row's
// project label renders from that same state, so a project created here must
// land there immediately — not at the next 60s refresh — or the just-assigned
// row stays unlabeled for seconds.

import { useEffect, useRef, useState } from "react";
import { type Project } from "./lib";
import { trace } from "./devlog";
import { usePopoverFlip } from "./usePopoverFlip";
import { usePopoverKeys } from "./usePopoverKeys";

export default function ProjectMenu({
  projects, projectId, onAssign, onCreateProject, kb,
}: {
  projects: Project[];
  projectId: string | null;
  onAssign: (projectId: string | null) => void;
  onCreateProject: (name: string) => Promise<Project>;
  kb?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const flip = usePopoverFlip(open, ref, menuRef);

  // Close on outside click or Escape (from anywhere inside — the create
  // field's keys bubble to this document listener).
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
    trace("project.assign", { project: id === null ? null : projects.find((p) => p.id === id)?.name });
    setOpen(false);
    setDraft("");
    onAssign(id);
  };

  const createAndAssign = async () => {
    const name = draft.trim();
    if (!name) return;
    trace("project.create", { name });
    try {
      const p = await onCreateProject(name);
      assign(p.id);
    } catch {
      // leave menu open on failure so the user can retry
    }
  };

  // "No project" is row 0; the roster follows. The highlight opens on the
  // current assignment.
  const { hi, setHi, onKeyDown } = usePopoverKeys({
    open,
    menuRef,
    count: projects.length + 1,
    initialIndex: () => (projectId ? projects.findIndex((p) => p.id === projectId) + 1 : 0),
    onPick: (i) => assign(i === 0 ? null : projects[i - 1].id),
    onType: (ch) => {
      setDraft((d) => d + ch);
      inputRef.current?.focus();
    },
  });

  return (
    <div className="hide-menu-wrap" ref={ref}>
      <button
        className="item-action"
        data-kb={kb}
        onClick={(e) => {
          e.stopPropagation();
          if (!open) trace("popover.open", { menu: "project" });
          setOpen(!open);
        }}
        title="Set project"
        aria-label="Set project"
        aria-expanded={open}
      >#</button>
      {open && (
        <div
          className={`hide-menu${flip ? " flip" : ""}`}
          ref={menuRef}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className={`hide-menu-item${hi === 0 ? " hi" : ""}`}
            onMouseEnter={() => setHi(0)}
            onClick={() => assign(null)}
          >
            <span className="hide-menu-label">No project</span>
            <span className="hide-menu-sub">{projectId === null ? "✓" : ""}</span>
          </button>
          {projects.map((p, i) => (
            <button
              key={p.id}
              className={`hide-menu-item${hi === i + 1 ? " hi" : ""}`}
              onMouseEnter={() => setHi(i + 1)}
              onClick={() => assign(p.id)}
            >
              <span className="hide-menu-label">{p.name}</span>
              <span className="hide-menu-sub">{p.id === projectId ? "✓" : ""}</span>
            </button>
          ))}
          <div className="hide-menu-divider" />
          <input
            className="menu-input"
            ref={inputRef}
            value={draft}
            placeholder="New project…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createAndAssign(); }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}

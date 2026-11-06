// ProjectMenu — the assignment rows: "No project" to clear, the roster (the
// current one marked), and an inline input to create-and-assign a new
// project — any printable key lands in the create field. The list and
// creation come from the parent (App's projects state): the row's project
// label renders from that same state, so a project created here must land
// there immediately — not at the next 60s refresh — or the just-assigned row
// stays unlabeled for seconds.

import { useRef, useState } from "react";
import { trace } from "../../logging/devlog";
import RowMenu from "./RowMenu";
import { IconHash } from "../icons";
import type { Project } from "../../types/project";

export default function ProjectMenu({
  projects, projectId, onAssign, onCreateProject, kb,
}: {
  projects: Project[];
  projectId: string | null;
  onAssign: (projectId: string | null) => void;
  onCreateProject: (name: string) => Promise<Project>;
  kb?: string;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const assign = (id: string | null, close: () => void) => {
    trace("project.assign", { project: id === null ? null : projects.find((p) => p.id === id)?.name });
    setDraft("");
    close();
    onAssign(id);
  };

  const createAndAssign = (close: () => void) => {
    const name = draft.trim();
    if (!name) return;
    trace("project.create", { name });
    onCreateProject(name)
      .then((p) => assign(p.id, close))
      .catch(() => {
        // leave menu open on failure so the user can retry
      });
  };

  return (
    <RowMenu
      kb={kb}
      label="Set project"
      icon={<IconHash />}
      traceName="project"
      // "No project" is row 0; the roster follows. The highlight opens on
      // the current assignment.
      count={projects.length + 1}
      initialIndex={() => (projectId ? projects.findIndex((p) => p.id === projectId) + 1 : 0)}
      onPick={(i, close) => assign(i === 0 ? null : projects[i - 1].id, close)}
      onType={(ch) => {
        setDraft((d) => d + ch);
        inputRef.current?.focus();
      }}
    >
      {({ hi, setHi, close }) => (
        <>
          <button
            className={`hide-menu-item${hi === 0 ? " hi" : ""}`}
            onMouseEnter={() => setHi(0)}
            onClick={() => assign(null, close)}
          >
            <span className="hide-menu-label">No project</span>
            <span className="hide-menu-sub">{projectId === null ? "✓" : ""}</span>
          </button>
          {projects.map((p, i) => (
            <button
              key={p.id}
              className={`hide-menu-item${hi === i + 1 ? " hi" : ""}`}
              onMouseEnter={() => setHi(i + 1)}
              onClick={() => assign(p.id, close)}
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
            onKeyDown={(e) => { if (e.key === "Enter") createAndAssign(close); }}
            onClick={(e) => e.stopPropagation()}
          />
        </>
      )}
    </RowMenu>
  );
}

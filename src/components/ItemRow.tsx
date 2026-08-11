// ItemRow — a single task row: checkbox, text (or inline editor), metadata,
// and the hover-revealed action buttons (edit / project / reminder / hide /
// delete). Drag handle is the ⠿ grip; DnD is wired by the parent via useSortable.
//
// Single click selects AND enters edit mode; the checkbox/buttons all
// stopPropagation so they keep working without triggering edit.

import { useEffect, useRef, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { formatReminder, projectColor, todayStr, type HideDuration, type Item, type Project } from "../lib";
import HideMenu from "../HideMenu";
import ProjectMenu from "../ProjectMenu";
import ReminderMenu from "../ReminderMenu";

export default function ItemRow({
  item, project, selected, editing,
  onSelect, onComplete, onDelete, onCommitEdit, onStartEdit, onHide,
  onSetProject, onSetReminder,
}: {
  item: Item;
  project: Project | null;
  selected: boolean;
  editing: boolean;
  onSelect: (id: string) => void;
  onComplete: () => void;
  onDelete: () => void;
  onCommitEdit: (text: string) => void;
  onStartEdit: () => void;
  onHide: (duration: HideDuration) => void;
  onSetProject: (projectId: string | null) => void;
  onSetReminder: (remindAt: string | null) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id });

  const doneToday =
    item.section === "daily" && item.lastCompletedDate === todayStr();
  const done = item.status === "done" || doneToday;

  return (
    <div
      ref={setNodeRef}
      data-item-id={item.id}
      className={`item${done ? " done" : ""}${selected ? " selected" : ""}${isDragging ? " dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onClick={() => { onSelect(item.id); if (!editing) onStartEdit(); }}
      {...attributes}
    >
      <span className="grip" {...listeners} title="Drag">⠿</span>

      <button
        className={`item-check${done ? " checked" : ""}`}
        onClick={(e) => { e.stopPropagation(); if (!done) onComplete(); }}
        title={doneToday ? "Completed for today" : "Mark done"}
        aria-label="Mark done"
      />

      {editing ? (
        <EditInput initial={item.text} onCommit={onCommitEdit} />
      ) : (
        <span className="item-text">{item.text}</span>
      )}

      {/* Right-aligned metadata (project label + reminder). Resting state shows
          this; on hover it yields to the action buttons (which take its place). */}
      {!editing && (project || item.remindAt) && (
        <div className="item-meta">
          {project && (
            <span
              className="project-label"
              style={{ color: projectColor(project.id) }}
              title={`Project: ${project.name}`}
            >{project.name}</span>
          )}
          {item.remindAt && (
            <span className="reminder-chip" title={`Reminds on ${item.remindAt}`}>
              → {formatReminder(item.remindAt)}
            </span>
          )}
        </div>
      )}

      {!editing && (
        <>
          <button
            className="item-action"
            onClick={(e) => { e.stopPropagation(); onStartEdit(); }}
            title="Edit"
            aria-label="Edit"
          >✎</button>
          <ProjectMenu projectId={item.projectId} onAssign={onSetProject} />
          <ReminderMenu remindAt={item.remindAt} onSet={onSetReminder} />
          <HideMenu onHide={onHide} />
          <button
            className="item-action danger"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            title="Delete"
            aria-label="Delete"
          >×</button>
        </>
      )}
    </div>
  );
}

// Controlled input that commits on Enter/blur, cancels on Escape.
// Focus lands at the end of the text (not a full select) so a click-to-edit
// appends naturally, like the notes textareas.
function EditInput({
  initial, onCommit,
}: {
  initial: string;
  onCommit: (text: string) => void;
}) {
  const [val, setVal] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const end = initial.length;
    el.setSelectionRange(end, end);
  }, [initial]);
  return (
    <input
      ref={ref}
      className="item-edit"
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onCommit(val)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); onCommit(val); }
        if (e.key === "Escape") onCommit(initial);
      }}
    />
  );
}

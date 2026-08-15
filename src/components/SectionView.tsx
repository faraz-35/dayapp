// SectionView — one of the three task sections (Today / Daily / Backlog).
// Renders: header (label + count), always-open capture input, sortable item
// rows, and a droppable empty zone so the section accepts drops even when empty.

import { useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { type HideDuration, type Item, type Project, type Section } from "../lib";
import ItemRow from "./ItemRow";

export default function SectionView({
  section, label, hint, items, projects, selectedId, editingId, showCapture,
  onSelect, onComplete, onDelete, onCommitEdit, onStartEdit, onQuickAdd, onHide, onUnhide,
  onSetProject, onSetReminder, activeTimerId, liveElapsed, timeTotals, onToggleTimer,
}: {
  section: Section;
  label: string;
  hint: string;
  items: Item[];
  projects: Project[];
  selectedId: string | null;
  editingId: string | null;
  showCapture: boolean;
  onSelect: (id: string) => void;
  onComplete: (id: string, section: Section) => void;
  onDelete: (id: string, section: Section) => void;
  onCommitEdit: (id: string, text: string) => void;
  onStartEdit: (id: string) => void;
  onQuickAdd: (section: Section, text: string) => void;
  onHide: (id: string, section: Section, duration: HideDuration) => void;
  onUnhide: (id: string) => void;
  onSetProject: (id: string, projectId: string | null) => void;
  onSetReminder: (id: string, remindAt: string | null) => void;
  activeTimerId: string | null;
  liveElapsed: number;
  timeTotals: Record<string, number>;
  onToggleTimer: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const { setNodeRef, isOver } = useDroppable({ id: `dropzone-${section}` });

  const submit = () => {
    const t = draft.trim();
    if (t) onQuickAdd(section, t);
    setDraft("");
  };

  return (
    <section className="section" style={{ minHeight: 40 }}>
      <div className="section-head" title={hint}>
        <span className="section-name">{label}</span>
      </div>

      {/* Always-open capture at the top of the section: type + Enter to add.
          No button, no click-to-reveal — the input itself is the affordance.
          Suppressed in hidden-only mode, where a new (non-hidden) item would
          vanish from the view on creation. */}
      {showCapture && (
        <div className="capture">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); submit(); }
              else if (e.key === "Escape") setDraft("");
            }}
            spellCheck={false}
          />
        </div>
      )}

      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        {items.map((item) => {
          const timing = item.id === activeTimerId;
          return (
            <ItemRow
              key={item.id}
              item={item}
              project={projects.find((p) => p.id === item.projectId) ?? null}
              selected={item.id === selectedId}
              editing={item.id === editingId}
              onSelect={onSelect}
              onComplete={() => onComplete(item.id, section)}
              onDelete={() => onDelete(item.id, section)}
              onCommitEdit={(text) => onCommitEdit(item.id, text)}
              onStartEdit={() => onStartEdit(item.id)}
              onHide={(duration) => onHide(item.id, section, duration)}
              onUnhide={() => onUnhide(item.id)}
              onSetProject={(projectId) => onSetProject(item.id, projectId)}
              onSetReminder={(remindAt) => onSetReminder(item.id, remindAt)}
              onToggleTimer={() => onToggleTimer(item.id)}
              isTiming={timing}
              elapsedSec={timing ? liveElapsed : 0}
              totalSec={timeTotals[item.id] ?? 0}
            />
          );
        })}
      </SortableContext>

      {/* Droppable empty zone — accepts drops even when the section is empty. */}
      <div ref={setNodeRef} className={`section-dropzone${isOver ? " is-over" : ""}`} />
    </section>
  );
}

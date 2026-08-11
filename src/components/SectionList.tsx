// SectionList — the three task sections inside a DndContext. Owns drag
// start/end, renders the DragOverlay, and maps the three SectionViews.
//
// All drag logic lives here (not in App) so App stays a thin shell. The parent
// owns item state and the mutation callbacks; this component just wires DnD
// around them.

import { useCallback, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { type HideDuration, type Item, type Project, type Section } from "../lib";
import SectionView from "./SectionView";

// The section definitions live here — they're presentation-only metadata the
// list cares about, not state the shell needs to touch.
const SECTIONS: { id: Section; label: string; hint: string }[] = [
  { id: "today", label: "Today", hint: "today's intent — falls to backlog at midnight" },
  { id: "daily", label: "Daily", hint: "resets every morning" },
  { id: "backlog", label: "Backlog", hint: "everything else; drag up to commit" },
];

export default function SectionList({
  items, projects, selectedId, editingId,
  onSelect, onComplete, onDelete, onCommitEdit, onStartEdit, onQuickAdd, onHide,
  onSetProject, onSetReminder, onMoveItem,
}: {
  items: Record<Section, Item[]>;
  projects: Project[];
  selectedId: string | null;
  editingId: string | null;
  onSelect: (id: string) => void;
  onComplete: (id: string, section: Section) => void;
  onDelete: (id: string, section: Section) => void;
  onCommitEdit: (id: string, text: string) => void;
  onStartEdit: (id: string) => void;
  onQuickAdd: (section: Section, text: string) => void;
  onHide: (id: string, section: Section, duration: HideDuration) => void;
  onSetProject: (id: string, projectId: string | null) => void;
  onSetReminder: (id: string, remindAt: string | null) => void;
  onMoveItem: (id: string, toSection: Section, newIndex: number) => void;
}) {
  const [activeDrag, setActiveDrag] = useState<Item | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const findItem = useCallback(
    (id: string): Item | undefined =>
      items.today.find((i) => i.id === id) ??
      items.daily.find((i) => i.id === id) ??
      items.backlog.find((i) => i.id === id),
    [items],
  );

  const onDragStart = (e: DragStartEvent) => {
    const item = findItem(e.active.id as string);
    if (item) setActiveDrag(item);
  };

  const onDragEnd = (e: DragEndEvent) => {
    setActiveDrag(null);
    const { active, over } = e;
    if (!over) return;
    const activeItem = findItem(active.id as string);
    if (!activeItem) return;

    // `over.id` is either an item id, or a dropzone id (dropped on empty area).
    const overId = String(over.id);
    let overSection: Section;
    let newIndex: number;
    if (overId.startsWith("dropzone-")) {
      overSection = overId.replace("dropzone-", "") as Section;
      newIndex = items[overSection].length;
    } else {
      const overItem = findItem(overId);
      if (!overItem) return;
      overSection = overItem.section;
      newIndex = items[overSection].findIndex((i) => i.id === overId);
      if (newIndex === -1) newIndex = items[overSection].length;
    }

    // No-op if dropped in place.
    const currentIdx = items[overSection].findIndex((i) => i.id === activeItem.id);
    if (overSection === activeItem.section && currentIdx === newIndex) {
      return;
    }

    onMoveItem(activeItem.id, overSection, newIndex);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <main className="sections">
        {SECTIONS.map((sec) => (
          <SectionView
            key={sec.id}
            section={sec.id}
            label={sec.label}
            hint={sec.hint}
            items={items[sec.id]}
            projects={projects}
            selectedId={selectedId}
            editingId={editingId}
            onSelect={onSelect}
            onComplete={onComplete}
            onDelete={onDelete}
            onCommitEdit={onCommitEdit}
            onStartEdit={onStartEdit}
            onQuickAdd={onQuickAdd}
            onHide={onHide}
            onSetProject={onSetProject}
            onSetReminder={onSetReminder}
          />
        ))}
      </main>

      <DragOverlay>
        {activeDrag ? (
          <div className="drag-overlay">
            <span style={{ color: "var(--text-faint)" }}>⠿</span>
            <span className="item-text">{activeDrag.text}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

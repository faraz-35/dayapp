// SectionList — the ONE task capture above the three task sections inside a
// DndContext. Owns the capture bus (a leading ##t/##d/##b routes the line to
// Today/Daily/Backlog, no token = Today — the notes bar's ##j/##q pattern),
// drag start/end, renders the DragOverlay, and maps the three SectionViews.
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
import { parseTaskCapture, type HideDuration, type Item, type Project, type Section } from "../lib";
import TokenField from "../TokenField";
import SectionView from "./SectionView";

// The section definitions live here — they're presentation-only metadata the
// list cares about, not state the shell needs to touch.
const SECTIONS: { id: Section; label: string; hint: string }[] = [
  { id: "today", label: "Today", hint: "today's intent — falls to backlog at midnight" },
  { id: "daily", label: "Daily", hint: "resets every morning" },
  { id: "backlog", label: "Backlog", hint: "everything else; drag up to commit" },
];

export default function SectionList({
  items, visible, projects, selectedId, editingId, detailsOpenId,
  onSelect, onComplete, onDelete, onCommitEdit, onStartEdit, onQuickAdd, onHide, onUnhide,
  onSetProject, onCreateProject, onSetReminder, onMoveItem, onPromote, onToggleDetails, onSetDetails,
  activeTimerId, liveElapsed, timeTotals, onToggleTimer,
}: {
  items: Record<Section, Item[]>;
  /** Per-section ⌘P Show/Hide toggle — a toggled-off section doesn't render at
   *  all (its items stay in state; the parent already narrows `items` to the
   *  visible sections, this keeps the section heads/dropzones off screen). */
  visible: Record<Section, boolean>;
  projects: Project[];
  selectedId: string | null;
  editingId: string | null;
  detailsOpenId: string | null;
  onSelect: (id: string) => void;
  onComplete: (id: string, section: Section) => void;
  onDelete: (id: string, section: Section) => void;
  onCommitEdit: (id: string, text: string) => void;
  onStartEdit: (id: string) => void;
  onQuickAdd: (section: Section, text: string) => void;
  onHide: (id: string, section: Section, duration: HideDuration) => void;
  onUnhide: (id: string) => void;
  onSetProject: (id: string, projectId: string | null) => void;
  onCreateProject: (name: string) => Promise<Project>;
  onSetReminder: (id: string, remindAt: string | null) => void;
  onMoveItem: (id: string, toSection: Section, newIndex: number) => void;
  /** Send a Backlog row to the end of Today — the section's slot-1 verb. */
  onPromote: (id: string) => void;
  onToggleDetails: (id: string) => void;
  onSetDetails: (id: string, details: string) => void;
  activeTimerId: string | null;
  liveElapsed: number;
  timeTotals: Record<string, number>;
  onToggleTimer: (id: string) => void;
}) {
  const [activeDrag, setActiveDrag] = useState<Item | null>(null);
  // The task bus's draft. One field for all three destinations — the route
  // token decides at Enter, so it survives while the user retypes it.
  const [draft, setDraft] = useState("");

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

  const submit = () => {
    const t = draft.trim();
    if (!t) return;
    const { section, text } = parseTaskCapture(t);
    // A bare route token with no text is a no-op — no junk row, the entries
    // rule. The stripped text still runs App's item grammar (#tag/!N/@).
    if (text) onQuickAdd(section, text);
    setDraft("");
  };

  return (
    <>
      {/* The stack's surface header — the Notes pattern: a name above the
          capture, a step brighter than the Today/Daily/Backlog names (it
          labels the whole task surface, not a subsection of it). Not inside
          a padded section like Notes' head, so .surface-head carries the
          extra inset (and the seam's breathing room) itself. */}
      <div className="section-head surface-head">
        <span className="section-name surface-name">Tasks</span>
      </div>

      {/* The one task capture, above the stack: type + Enter to add, a leading
          ##t/##d/##b to choose the destination (no token = Today). No button,
          no click-to-reveal — the input itself is the affordance. Mounted
          outside the DndContext so typing is never a drag surface;
          data-capture="tasks" is the grammar's nt/nd/nb target, `route` wires
          the token prefill, and TokenField colors the typed grammar (##route,
          #tag, !N, @) — exactly what Enter parses. */}
      <div className="capture task-capture">
        <TokenField
          kinds={["section", "project", "priority", "agent"]}
          capture="tasks"
          route
          value={draft}
          onChange={setDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); submit(); }
            // Empty draft → blur: the Esc ladder's editing → nothing rung
            // for captures (a capture input isn't a grammar focus target).
            else if (e.key === "Escape") {
              if (draft) setDraft("");
              else e.currentTarget.blur();
            }
          }}
        />
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <main className="sections">
          {SECTIONS.filter((sec) => visible[sec.id]).map((sec) => (
            <SectionView
              key={sec.id}
              section={sec.id}
              label={sec.label}
              hint={sec.hint}
              items={items[sec.id]}
              projects={projects}
              selectedId={selectedId}
              editingId={editingId}
              detailsOpenId={detailsOpenId}
              onSelect={onSelect}
              onComplete={onComplete}
              onDelete={onDelete}
              onCommitEdit={onCommitEdit}
              onStartEdit={onStartEdit}
              onHide={onHide}
              onUnhide={onUnhide}
              onSetProject={onSetProject}
              onCreateProject={onCreateProject}
              onSetReminder={onSetReminder}
              onPromote={onPromote}
              onToggleDetails={onToggleDetails}
              onSetDetails={onSetDetails}
              activeTimerId={activeTimerId}
              liveElapsed={liveElapsed}
              timeTotals={timeTotals}
              onToggleTimer={onToggleTimer}
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
    </>
  );
}

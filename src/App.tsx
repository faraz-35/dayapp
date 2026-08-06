import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  closestCorners,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { api, todayStr, type Action, type Item, type Section } from "./lib";

const SECTIONS: { id: Section; label: string; hint: string }[] = [
  { id: "today", label: "Today", hint: "today's intent — falls to backlog at midnight" },
  { id: "daily", label: "Daily", hint: "resets every morning" },
  { id: "backlog", label: "Backlog", hint: "everything else; drag up to commit" },
];

type View = "list" | "journal";

export default function App() {
  const [items, setItems] = useState<Record<Section, Item[]>>({
    today: [],
    daily: [],
    backlog: [],
  });
  const [doneCount, setDoneCount] = useState(0);
  const [activeDrag, setActiveDrag] = useState<Item | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [view, setView] = useState<View>("list");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // ---- Load -------------------------------------------------------------

  const refresh = useCallback(async () => {
    const [today, daily, backlog, count] = await Promise.all([
      api.listItems("today", false),
      api.listItems("daily", false),
      api.listItems("backlog", false),
      api.countCompletions(todayStr()),
    ]);
    setItems({ today, daily, backlog });
    setDoneCount(count);
  }, []);

  useEffect(() => {
    refresh();
    // Re-check the day boundary while the app stays open. If local time crosses
    // midnight, run the sweep so Today items fall to Backlog without a relaunch.
    const tick = setInterval(() => {
      api.runSweep().then(refresh).catch(() => {});
    }, 60_000);
    return () => clearInterval(tick);
  }, [refresh]);

  // ---- Mutations --------------------------------------------------------

  const handleCreate = async (section: Section, text: string) => {
    const item = await api.createItem(text, section);
    setItems((s) => ({ ...s, [section]: [...s[section], item] }));
  };

  const handleComplete = async (id: string, section: Section) => {
    if (section === "daily") {
      setItems((s) => ({
        ...s,
        daily: s.daily.map((i) =>
          i.id === id ? { ...i, lastCompletedDate: todayStr() } : i,
        ),
      }));
    } else {
      setItems((s) => ({
        ...s,
        [section]: s[section].filter((i) => i.id !== id),
      }));
    }
    await api.completeItem(id);
    setDoneCount((c) => c + 1);
  };

  const handleDelete = async (id: string, section: Section) => {
    setItems((s) => ({ ...s, [section]: s[section].filter((i) => i.id !== id) }));
    await api.deleteItem(id);
  };

  const handleCommitEdit = async (id: string, text: string) => {
    const t = text.trim();
    setEditingId(null);
    if (!t) return;
    setItems((s) => {
      const update = (list: Item[]) => list.map((i) => (i.id === id ? { ...i, text: t } : i));
      return {
        today: update(s.today),
        daily: update(s.daily),
        backlog: update(s.backlog),
      };
    });
    await api.editItem(id, t);
  };

  // ---- DnD --------------------------------------------------------------

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

  const onDragEnd = async (e: DragEndEvent) => {
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

    // Optimistic reorder/move.
    setItems((s) => {
      if (overSection === activeItem.section) {
        const list = s[activeItem.section].filter((i) => i.id !== activeItem.id);
        list.splice(newIndex, 0, activeItem);
        return { ...s, [activeItem.section]: list };
      }
      const fromList = s[activeItem.section].filter((i) => i.id !== activeItem.id);
      const toList = [...s[overSection]];
      toList.splice(newIndex, 0, activeItem);
      return { ...s, [activeItem.section]: fromList, [overSection]: toList };
    });

    await api.moveItem(activeItem.id, overSection, newIndex);
  };

  // ---- Keyboard nav ----------------------------------------------------

  const allVisible = useMemo(
    () => [...items.today, ...items.daily, ...items.backlog],
    [items],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (view !== "list") return;
      const target = e.target as HTMLElement;
      const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA";

      if (typing) return;

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        moveSelection(1);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        moveSelection(-1);
      } else if (e.key === "Enter" && selectedId) {
        const item = allVisible.find((i) => i.id === selectedId);
        if (item) { e.preventDefault(); handleComplete(item.id, item.section); }
      } else if (e.key === "e" && selectedId) {
        e.preventDefault();
        setEditingId(selectedId);
      } else if ((e.key === "Backspace" || e.key === "Delete") && selectedId) {
        const item = allVisible.find((i) => i.id === selectedId);
        if (item) { e.preventDefault(); handleDelete(item.id, item.section); }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allVisible, selectedId, view]);

  const moveSelection = (delta: number) => {
    const idx = allVisible.findIndex((i) => i.id === selectedId);
    const next = idx === -1 ? 0 : Math.min(allVisible.length - 1, Math.max(0, idx + delta));
    setSelectedId(allVisible[next]?.id ?? null);
  };

  // ---- Render ----------------------------------------------------------

  return (
    <div>
      <header className="header">
        <span className="title">{view === "list" ? "Today" : "Journal"}</span>
        <div className="header-right">
          {view === "list" && (
            <span className="counter" title="Completions today — balls in the box">
              <span className="counter-dot" />
              {doneCount} today
            </span>
          )}
          <button
            className={`icon-btn ${view === "journal" ? "active" : ""}`}
            onClick={() => setView(view === "journal" ? "list" : "journal")}
            title={view === "journal" ? "Back to list" : "View journal"}
            aria-label="Toggle journal"
          >
            {view === "journal" ? "✕" : "≡"}
          </button>
        </div>
      </header>

      {view === "list" ? (
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
                selectedId={selectedId}
                editingId={editingId}
                onSelect={setSelectedId}
                onComplete={handleComplete}
                onDelete={handleDelete}
                onCommitEdit={handleCommitEdit}
                onStartEdit={setEditingId}
                onQuickAdd={handleCreate}
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
      ) : (
        <JournalView />
      )}
    </div>
  );
}

// ---- Section -------------------------------------------------------------

function SectionView({
  section, label, hint, items, selectedId, editingId,
  onSelect, onComplete, onDelete, onCommitEdit, onStartEdit, onQuickAdd,
}: {
  section: Section;
  label: string;
  hint: string;
  items: Item[];
  selectedId: string | null;
  editingId: string | null;
  onSelect: (id: string) => void;
  onComplete: (id: string, section: Section) => void;
  onDelete: (id: string, section: Section) => void;
  onCommitEdit: (id: string, text: string) => void;
  onStartEdit: (id: string) => void;
  onQuickAdd: (section: Section, text: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const { setNodeRef, isOver } = useDroppable({ id: `dropzone-${section}` });

  const submit = () => {
    const t = draft.trim();
    if (t) onQuickAdd(section, t);
    setDraft("");
    setAdding(false);
  };

  return (
    <section style={{ minHeight: 40 }}>
      <div className="section-head" title={hint}>
        <span className="section-name">{label}</span>
        <span className="section-count">{items.length || ""}</span>
      </div>

      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        {items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            selected={item.id === selectedId}
            editing={item.id === editingId}
            onSelect={onSelect}
            onComplete={() => onComplete(item.id, section)}
            onDelete={() => onDelete(item.id, section)}
            onCommitEdit={(text) => onCommitEdit(item.id, text)}
            onStartEdit={() => onStartEdit(item.id)}
          />
        ))}
      </SortableContext>

      {/* Droppable empty zone — accepts drops even when the section is empty. */}
      <div ref={setNodeRef} className={`section-dropzone${isOver ? " is-over" : ""}`} />

      {items.length === 0 && !adding && <div className="empty">Nothing here.</div>}

      <div className="quickadd" onClick={() => setAdding(true)}>
        <span style={{ color: "var(--text-faint)" }}>+</span>
        {adding ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={submit}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") { setAdding(false); setDraft(""); }
            }}
            placeholder={`Add to ${label.toLowerCase()}…`}
          />
        ) : (
          <span className="quickadd-hint">Add to {label.toLowerCase()}…</span>
        )}
      </div>
    </section>
  );
}

// ---- Item row -----------------------------------------------------------

function ItemRow({
  item, selected, editing,
  onSelect, onComplete, onDelete, onCommitEdit, onStartEdit,
}: {
  item: Item;
  selected: boolean;
  editing: boolean;
  onSelect: (id: string) => void;
  onComplete: () => void;
  onDelete: () => void;
  onCommitEdit: (text: string) => void;
  onStartEdit: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id });

  const doneToday =
    item.section === "daily" && item.lastCompletedDate === todayStr();
  const done = item.status === "done" || doneToday;

  return (
    <div
      ref={setNodeRef}
      className={`item${done ? " done" : ""}${selected ? " selected" : ""}${isDragging ? " dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onClick={() => onSelect(item.id)}
      onDoubleClick={onStartEdit}
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
        <span
          className="item-text"
          onDoubleClick={(e) => { e.stopPropagation(); onStartEdit(); }}
        >
          {item.text}
        </span>
      )}

      {!editing && (
        <>
          <button
            className="item-action"
            onClick={(e) => { e.stopPropagation(); onStartEdit(); }}
            title="Edit"
            aria-label="Edit"
          >✎</button>
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
function EditInput({
  initial, onCommit,
}: {
  initial: string;
  onCommit: (text: string) => void;
}) {
  const [val, setVal] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
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

// ---- Journal view -------------------------------------------------------
// Reads the append-only `actions` log and groups by day. This is the auto-journal:
// every create/complete/move/edit/delete/sweep writes a row, so the view composes itself.

const VERB: Record<string, string> = {
  created: "added",
  completed: "completed",
  uncompleted: "unchecked",
  moved: "moved",
  edited: "edited",
  deleted: "deleted",
  fell_to_backlog: "fell to backlog",
};

function JournalView() {
  const [actions, setActions] = useState<Action[]>([]);
  const [filter, setFilter] = useState<string>("all");

  useEffect(() => {
    api.listActions(500).then(setActions);
  }, []);

  const filtered = useMemo(() => {
    if (filter === "all") return actions;
    return actions.filter((a) => a.action === filter);
  }, [actions, filter]);

  // Group by YYYY-MM-DD, preserving reverse-chronological order.
  const groups = useMemo(() => {
    const map = new Map<string, Action[]>();
    for (const a of filtered) {
      const day = a.timestamp.slice(0, 10);
      if (!map.has(day)) map.set(day, []);
      map.get(day)!.push(a);
    }
    return Array.from(map.entries());
  }, [filtered]);

  const filters = [
    { id: "all", label: "All" },
    { id: "completed", label: "Done" },
    { id: "created", label: "Added" },
    { id: "moved", label: "Moved" },
    { id: "fell_to_backlog", label: "Fell" },
    { id: "deleted", label: "Deleted" },
  ];

  return (
    <div>
      <div className="filter-bar">
        {filters.map((f) => (
          <button
            key={f.id}
            className={`pill${filter === f.id ? " active" : ""}`}
            onClick={() => setFilter(f.id)}
          >{f.label}</button>
        ))}
      </div>
      <div className="journal">
        {groups.length === 0 && <div className="journal-empty">No activity yet.</div>}
        {groups.map(([day, rows]) => (
          <div key={day}>
            <div className="journal-day">{day}</div>
            {rows.map((a) => (
              <div key={a.id} className="journal-row">
                <span className="journal-time">{a.timestamp.slice(11, 16)}</span>
                <span className="journal-verb">{VERB[a.action] ?? a.action}</span>
                <span className="journal-text">{a.itemText}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

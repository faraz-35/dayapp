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
import { api, localDateStr, localDateStrOffset, projectsApi, todayStr, type Action, type HideDuration, type Item, type Project, type Section } from "./lib";
import { notesApi, type Note } from "./notesApi";
import { log } from "./log";
import Notes from "./Notes";
import HideMenu from "./HideMenu";
import ProjectMenu from "./ProjectMenu";
import ReminderMenu from "./ReminderMenu";
import CommandPalette, { type Command } from "./CommandPalette";
import UpdateOverlay from "./UpdateOverlay";

const SECTIONS: { id: Section; label: string; hint: string }[] = [
  { id: "today", label: "Today", hint: "today's intent — falls to backlog at midnight" },
  { id: "daily", label: "Daily", hint: "resets every morning" },
  { id: "backlog", label: "Backlog", hint: "everything else; drag up to commit" },
];

// Format an ISO YYYY-MM-DD reminder as a short, scannable chip (→ Aug 12).
function formatReminder(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Deterministic, well-spaced color per project so the eye can group items at a
// glance. Hash the id → hue; fixed S/L tuned for legibility on the dark bg. The
// golden-angle offset spreads consecutive projects apart on the wheel.
function projectColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 65% 68%)`;
}

type View = "list" | "journal" | "hidden";

// Self-update status, accumulated from "update-status" events emitted by the
// backend's self_update command. `lines` is the streamed build log; `message`
// is populated only on error.
export type UpdateStatus = {
  phase: "building" | "restarting" | "error";
  lines: string[];
  message: string;
};

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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // ---- Load -------------------------------------------------------------

  const refresh = useCallback(async () => {
    const [today, daily, backlog, count, projs] = await Promise.all([
      api.listItems("today", false),
      api.listItems("daily", false),
      api.listItems("backlog", false),
      api.countCompletions(todayStr()),
      projectsApi.list(),
    ]);
    setItems({ today, daily, backlog });
    setDoneCount(count);
    setProjects(projs);
  }, []);

  useEffect(() => {
    refresh().catch((e) => log.error("initial load failed", e));
    // Re-check the day boundary while the app stays open. If local time crosses
    // midnight, run the sweep so Today items fall to Backlog without a relaunch.
    const tick = setInterval(() => {
      api.runSweep().then(refresh).catch((e) => log.warn("sweep tick failed", e));
    }, 60_000);
    return () => clearInterval(tick);
  }, [refresh]);

  // ---- Self-update: accumulate "update-status" events from the backend ----
  // Each building line appends to the log; restarting/error flip the phase.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{ phase: string; data: string }>("update-status", (e) => {
        const { phase, data } = e.payload;
        if (phase === "restarting") log.info("update: build done, restarting");
        else if (phase === "error") log.error("update: build failed", data);
        setUpdateStatus((prev) => {
          if (phase === "building") {
            const lines = prev && prev.phase === "building" ? [...prev.lines, data] : [data];
            return { phase: "building", lines, message: "" };
          }
          if (phase === "restarting") {
            return { phase: "restarting", lines: prev?.lines ?? [], message: "" };
          }
          if (phase === "error") {
            return { phase: "error", lines: prev?.lines ?? [], message: data };
          }
          return prev;
        });
      });
    })();
    return () => { unlisten?.(); };
  }, []);

  const startUpdate = useCallback(() => {
    log.info("update: starting in-app self-update");
    setUpdateStatus({ phase: "building", lines: [], message: "" });
    api.selfUpdate().catch((err) => {
      log.error("update: invoke failed", err);
      setUpdateStatus({ phase: "error", lines: [], message: String(err) });
    });
  }, []);

  // ---- Command palette registry -----------------------------------------
  // The set of commands shown in the ⌘P palette. Navigation + the update
  // command for now; trivially extensible.
  const commands: Command[] = useMemo(() => [
    { id: "view-today", label: "Go to Today", run: () => setView("list") },
    { id: "view-journal", label: "View Journal", run: () => setView("journal") },
    { id: "view-hidden", label: "View Hidden", run: () => setView("hidden") },
    {
      id: "update",
      label: "Update DayApp",
      hint: "rebuild from source",
      run: startUpdate,
    },
  ], [startUpdate]);

  // ⌘P / Ctrl+P toggles the palette from anywhere (unless typing in a field).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "p") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

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

  // Soft-archive a task. Optimistically removed from its section; time-limited
  // hides auto-restore via the day-boundary sweep, so no timer needed here.
  const handleHide = async (id: string, section: Section, duration: HideDuration) => {
    setItems((s) => ({ ...s, [section]: s[section].filter((i) => i.id !== id) }));
    await api.hideItem(id, duration);
  };

  // Assign (or clear) an item's project. Housekeeping — not journal activity.
  const updateItemField = (id: string, patch: Partial<Item>) => {
    setItems((s) => {
      const upd = (list: Item[]) => list.map((i) => (i.id === id ? { ...i, ...patch } : i));
      return { today: upd(s.today), daily: upd(s.daily), backlog: upd(s.backlog) };
    });
  };

  const handleSetProject = async (id: string, projectId: string | null) => {
    updateItemField(id, { projectId });
    await api.setItemProject(id, projectId);
  };

  const handleSetReminder = async (id: string, remindAt: string | null) => {
    updateItemField(id, { remindAt });
    await api.setReminder(id, remindAt);
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
        <span className="title">
          {view === "list" ? "Today" : view === "journal" ? "Journal" : "Hidden"}
        </span>
        <div className="header-right">
          {view === "list" && (
            <span className="counter" title="Completions today — balls in the box">
              <span className="counter-dot" />
              {doneCount} today
            </span>
          )}
          <button
            className={`icon-btn ${view === "hidden" ? "active" : ""}`}
            onClick={() => setView(view === "hidden" ? "list" : "hidden")}
            title={view === "hidden" ? "Back to list" : "View hidden"}
            aria-label="Toggle hidden"
          >
            {view === "hidden" ? "✕" : "◐"}
          </button>
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
        <>
        {/* Notes live above the DnD area so typing/pasting isn't a drag surface.
            Self-contained: owns its state, API, and persistence. */}
        <Notes />
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
                onSelect={setSelectedId}
                onComplete={handleComplete}
                onDelete={handleDelete}
                onCommitEdit={handleCommitEdit}
                onStartEdit={setEditingId}
                onQuickAdd={handleCreate}
                onHide={handleHide}
                onSetProject={handleSetProject}
                onSetReminder={handleSetReminder}
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
      ) : view === "journal" ? (
        <JournalView />
      ) : (
        <HiddenView />
      )}

      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />
      <UpdateOverlay
        status={updateStatus}
        onDismiss={() => setUpdateStatus(null)}
      />
    </div>
  );
}

// ---- Section -------------------------------------------------------------

function SectionView({
  section, label, hint, items, projects, selectedId, editingId,
  onSelect, onComplete, onDelete, onCommitEdit, onStartEdit, onQuickAdd, onHide,
  onSetProject, onSetReminder,
}: {
  section: Section;
  label: string;
  hint: string;
  items: Item[];
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
}) {
  const [draft, setDraft] = useState("");
  const { setNodeRef, isOver } = useDroppable({ id: `dropzone-${section}` });

  const submit = () => {
    const t = draft.trim();
    if (t) onQuickAdd(section, t);
    setDraft("");
  };

  return (
    <section style={{ minHeight: 40 }}>
      <div className="section-head" title={hint}>
        <span className="section-name">{label}</span>
        <span className="section-count">{items.length || ""}</span>
      </div>

      {/* Always-open capture at the top of the section: type + Enter to add.
          No button, no click-to-reveal — the input itself is the affordance. */}
      <div className="capture">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); submit(); }
            else if (e.key === "Escape") setDraft("");
          }}
          placeholder="..."
          spellCheck={false}
        />
      </div>

      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        {items.map((item) => (
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
            onSetProject={(projectId) => onSetProject(item.id, projectId)}
            onSetReminder={(remindAt) => onSetReminder(item.id, remindAt)}
          />
        ))}
      </SortableContext>

      {/* Droppable empty zone — accepts drops even when the section is empty. */}
      <div ref={setNodeRef} className={`section-dropzone${isOver ? " is-over" : ""}`} />

      {items.length === 0 && <div className="empty">Nothing here.</div>}
    </section>
  );
}

// ---- Item row -----------------------------------------------------------

function ItemRow({
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

type JournalRange = "today" | "week" | "month" | "all";

function JournalView() {
  const [actions, setActions] = useState<Action[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [range, setRange] = useState<JournalRange>("today");
  // When set, overrides the range pills with a single specific day.
  const [dayPick, setDayPick] = useState<string | null>(null);

  // Resolve the half-open [since, until) window from the active range/pick.
  // `until` is the day *after* the target so a day boundary is inclusive.
  const bounds = useMemo(() => {
    const addDays = (iso: string, days: number) => {
      const d = new Date(iso + "T00:00:00");
      d.setDate(d.getDate() + days);
      return localDateStr(d);
    };
    if (dayPick) return { since: dayPick, until: addDays(dayPick, 1) };
    switch (range) {
      case "today": return { since: localDateStr(), until: localDateStrOffset(1) };
      case "week":  return { since: localDateStrOffset(-6), until: localDateStrOffset(1) };
      case "month": return { since: localDateStrOffset(-29), until: localDateStrOffset(1) };
      case "all":   return { since: undefined, until: undefined };
    }
  }, [range, dayPick]);

  useEffect(() => {
    api.listActions({ since: bounds.since, until: bounds.until }).then(setActions);
  }, [bounds]);

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

  const ranges: { id: JournalRange; label: string }[] = [
    { id: "today", label: "Today" },
    { id: "week", label: "Week" },
    { id: "month", label: "Month" },
    { id: "all", label: "All" },
  ];

  return (
    <div>
      {/* One calm toolbar: range segments · date jump | action-type segments.
          Picking a date overrides the range pills until a pill is clicked. */}
      <div className="filter-bar">
        {ranges.map((r) => (
          <button
            key={r.id}
            className={`pill${!dayPick && range === r.id ? " active" : ""}`}
            onClick={() => { setRange(r.id); setDayPick(null); }}
          >{r.label}</button>
        ))}
        <input
          type="date"
          className={`date-jump${dayPick ? " active" : ""}`}
          value={dayPick ?? localDateStr()}
          onChange={(e) => setDayPick(e.target.value || null)}
          title="Jump to a specific day"
        />
        <span className="filter-sep" />
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

// ---- Hidden view -------------------------------------------------------
// Soft-archive: items and notes hidden via the ◐ menu collect here. Each row
// can be unhidden (↺) or deleted. Time-limited hides auto-leave this view when
// the day-boundary sweep clears their expiry, so nothing here needs a timer.

const hideExpiryLabel = (until: string | null): string => {
  if (!until) return "forever";
  // until is ISO YYYY-MM-DD; show a friendly relative-ish label.
  return `until ${until}`;
};

function HiddenView() {
  const [items, setItems] = useState<Item[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);

  const refresh = useCallback(async () => {
    const [hiddenItems, hiddenNotes] = await Promise.all([
      api.listHiddenItems(),
      notesApi.listHidden(),
    ]);
    setItems(hiddenItems);
    setNotes(hiddenNotes);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleUnhideItem = async (id: string) => {
    setItems((s) => s.filter((i) => i.id !== id));
    await api.unhideItem(id);
  };
  const handleDeleteItem = async (id: string) => {
    setItems((s) => s.filter((i) => i.id !== id));
    await api.deleteItem(id);
  };
  const handleUnhideNote = async (id: string) => {
    setNotes((s) => s.filter((n) => n.id !== id));
    await notesApi.unhide(id);
  };
  const handleDeleteNote = async (id: string) => {
    setNotes((s) => s.filter((n) => n.id !== id));
    await notesApi.delete(id);
  };

  const empty = items.length === 0 && notes.length === 0;

  return (
    <div className="hidden-view">
      {empty && <div className="empty">Nothing hidden.</div>}

      {items.length > 0 && (
        <>
          <div className="section-head">
            <span className="section-name">Tasks</span>
            <span className="section-count">{items.length}</span>
          </div>
          {items.map((item) => (
            <div key={item.id} className="hidden-row">
              <span className={`hidden-badge ${item.hiddenUntil ? "dated" : ""}`}>
                {hideExpiryLabel(item.hiddenUntil)}
              </span>
              <span className="hidden-text">{item.text}</span>
              <button
                className="item-action unhide-btn"
                onClick={() => handleUnhideItem(item.id)}
                title="Unhide"
                aria-label="Unhide"
              >↺</button>
              <button
                className="item-action danger"
                onClick={() => handleDeleteItem(item.id)}
                title="Delete"
                aria-label="Delete"
              >×</button>
            </div>
          ))}
        </>
      )}

      {notes.length > 0 && (
        <>
          <div className="section-head">
            <span className="section-name">Notes</span>
            <span className="section-count">{notes.length}</span>
          </div>
          {notes.map((note) => (
            <div key={note.id} className="hidden-row">
              <span className={`hidden-badge ${note.hiddenUntil ? "dated" : ""}`}>
                {hideExpiryLabel(note.hiddenUntil)}
              </span>
              <span className="hidden-text note-preview">
                {note.body.trim() || "Empty note"}
              </span>
              <button
                className="item-action unhide-btn"
                onClick={() => handleUnhideNote(note.id)}
                title="Unhide"
                aria-label="Unhide"
              >↺</button>
              <button
                className="item-action danger"
                onClick={() => handleDeleteNote(note.id)}
                title="Delete"
                aria-label="Delete"
              >×</button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

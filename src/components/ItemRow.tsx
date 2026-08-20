// ItemRow — a single task row: checkbox, text (or inline editor), metadata,
// and the hover-revealed action buttons (edit / project / reminder / hide /
// delete). Drag handle is the ⠿ grip; DnD is wired by the parent via useSortable.
//
// Completed Today rows render like a done daily — crossed out, in place — until
// the day-boundary sweep retires them; the checkbox (or Enter) toggles them back.
//
// Hidden rows (⌘P → Show Hidden Tasks) render inline but archived: dimmed
// text, an inert checkbox, a ◐ chip carrying the hide's expiry, no drag
// handle, and their only actions are unhide (↺) and delete.
//
// Single click selects AND enters edit mode; the checkbox/buttons all
// stopPropagation so they keep working without triggering edit.

import { useEffect, useRef, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { formatDuration, formatLiveDuration, formatReminder, localDateStr, projectColor, type HideDuration, type Item, type Project } from "../lib";
import HideMenu from "../HideMenu";
import ProjectMenu from "../ProjectMenu";
import ReminderMenu from "../ReminderMenu";

export default function ItemRow({
  item, projects, selected, editing, detailsOpen,
  onSelect, onComplete, onDelete, onCommitEdit, onStartEdit, onHide, onUnhide,
  onSetProject, onCreateProject, onSetReminder, onToggleDetails, onToggleTimer, isTiming, elapsedSec, totalSec,
}: {
  item: Item;
  projects: Project[];
  selected: boolean;
  editing: boolean;
  detailsOpen: boolean;
  onSelect: (id: string) => void;
  onComplete: () => void;
  onDelete: () => void;
  onCommitEdit: (text: string) => void;
  onStartEdit: () => void;
  onHide: (duration: HideDuration) => void;
  onUnhide: () => void;
  onSetProject: (projectId: string | null) => void;
  onCreateProject: (name: string) => Promise<Project>;
  onSetReminder: (remindAt: string | null) => void;
  onToggleDetails: () => void;
  onToggleTimer: () => void;
  isTiming: boolean;
  elapsedSec: number;
  totalSec: number;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id });

  const doneToday =
    item.section === "daily" && item.lastCompletedDate === localDateStr();
  const done = item.status === "done" || doneToday;
  const project = projects.find((p) => p.id === item.projectId) ?? null;

  // Backlog rows carry no bars — the section's tier dividers label the groups
  // there — so priority feeds the row's metadata only outside the Backlog.
  const priorityBars =
    item.priority != null && item.section !== "backlog" ? (
      <PriorityBars priority={item.priority} />
    ) : null;

  return (
    <div
      ref={setNodeRef}
      data-item-id={item.id}
      className={`item${done ? " done" : ""}${item.hidden ? " hidden" : ""}${selected ? " selected" : ""}${isDragging ? " dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onClick={() => { onSelect(item.id); if (!editing) onStartEdit(); }}
      {...attributes}
    >
      {/* The grip keeps its slot on hidden rows (so columns stay aligned) but
          carries no drag listeners — archived rows aren't reorderable. */}
      <span
        className="grip"
        {...(item.hidden ? {} : listeners)}
        title={item.hidden ? undefined : "Drag"}
      >⠿</span>

      <button
        className={`item-check${done ? " checked" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          if (item.hidden) return;
          // Daily's checked state is inert (completion is per-day); a crossed
          // Today row toggles back off.
          if (done && item.section !== "today") return;
          onComplete();
        }}
        title={item.hidden
          ? "Hidden — hover for ↺ unhide"
          : done
            ? item.section === "today" ? "Completed — click to undo" : "Completed for today"
            : "Mark done"}
        aria-label="Mark done"
      />

      {editing ? (
        <EditInput initial={item.text} onCommit={onCommitEdit} />
      ) : (
        <span className="item-text">{item.text}</span>
      )}

      {/* Right-aligned metadata (robot + priority + time + project label +
          reminder + details hint). Robot + priority + project stay visible on
          hover (the row's identity, wanted while its actions are on screen);
          time / reminder yield to the buttons. Suppressed while timing — the
          live elapsed then lives in the action cluster instead. */}
      {!editing && !isTiming && (item.hidden || totalSec > 0 || project || item.remindAt || priorityBars || item.assignedToAgent || item.details) && (
        <div className="item-meta">
          {item.assignedToAgent && <AgentBadge />}
          {priorityBars}
          {item.details && !detailsOpen && (
            <span
              className="details-hint"
              onClick={(e) => { e.stopPropagation(); onToggleDetails(); }}
              title="Has details — click to expand (d)"
            >⌄</span>
          )}
          {item.hidden && (
            <span
              className="hidden-chip"
              title={item.hiddenUntil
                ? `Hidden until ${item.hiddenUntil}`
                : "Hidden forever — hover for ↺ unhide"}
            >
              ◐ {item.hiddenUntil ? `until ${formatReminder(item.hiddenUntil)}` : "forever"}
            </span>
          )}
          {totalSec > 0 && (
            <span className="time-label" title="Time tracked">⏱ {formatDuration(totalSec)}</span>
          )}
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
          {/* Live elapsed shows only on the running row, always visible (not
              hover-gated) so the active timer is identifiable at a glance. A
              hidden row only ever shows the stop form — it can't start one. */}
          {isTiming && (
            <span className="timer-live" title="Elapsed">{formatLiveDuration(elapsedSec)}</span>
          )}
          {(isTiming || !item.hidden) && (
            <button
              className={`item-action timer-btn${isTiming ? " timing" : ""}`}
              onClick={(e) => { e.stopPropagation(); onToggleTimer(); }}
              title={isTiming ? "Stop timer" : "Start timer"}
              aria-label={isTiming ? "Stop timer" : "Start timer"}
            >{isTiming ? "⏸" : "▶"}</button>
          )}
          {item.hidden ? (
            <>
              <button
                className="item-action unhide-btn"
                onClick={(e) => { e.stopPropagation(); onUnhide(); }}
                title="Unhide"
                aria-label="Unhide"
              >↺</button>
              <button
                className="item-action danger"
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                title="Delete"
                aria-label="Delete"
              >×</button>
            </>
          ) : (
            <>
              <ProjectMenu
                projects={projects}
                projectId={item.projectId}
                onAssign={onSetProject}
                onCreateProject={onCreateProject}
              />
              <ReminderMenu remindAt={item.remindAt} onSet={onSetReminder} />
              <HideMenu onHide={onHide} />
              <button
                className={`item-action${detailsOpen ? " active" : ""}`}
                onClick={(e) => { e.stopPropagation(); onToggleDetails(); }}
                title={detailsOpen ? "Collapse details" : "Details — the task's spec (for agent tasks, the prompt)"}
                aria-label={detailsOpen ? "Collapse details" : "Show details"}
              >{detailsOpen ? "⌃" : "⋯"}</button>
              <button
                className="item-action danger"
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                title="Delete"
                aria-label="Delete"
              >×</button>
            </>
          )}
        </>
      )}
    </div>
  );
}

// The delegation badge: a small monochrome robot marking rows the AI agent can
// take end to end (the `@` token). Identity metadata like the project label —
// shown in every section (including the Backlog, unlike the bars: there's no
// agent grouping) and kept visible on hover. Monochrome SVG rather than the 🤖
// emoji so it tints with the metadata greys like every other row glyph; the
// emoji form is the symbol in the ⌘F picker and the CLI.
function AgentBadge() {
  return (
    <span className="agent-badge" title="Assigned to the AI agent">
      <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
        {/* antenna + head silhouette in currentColor; eyes punched in --bg */}
        <circle cx="6" cy="1.6" r="1" />
        <rect x="5.4" y="2.2" width="1.2" height="1.4" rx="0.6" />
        <rect x="1.8" y="3.4" width="8.4" height="6.8" rx="1.8" />
        <circle className="agent-eye" cx="4.5" cy="6.8" r="1" />
        <circle className="agent-eye" cx="7.5" cy="6.8" r="1" />
      </svg>
    </span>
  );
}

// The tier's signal bars: filled count = urgency (P1 = 3 filled, P3 = 1), so
// the most urgent tier carries the most visual mass. Shown on Today/Daily
// rows; in the Backlog the tier dividers use it as their label instead — rows
// there stay clean, the groups carry the tier. A null priority renders the
// bare track (no filled bars): the unmarked group's divider label.
export function PriorityBars({ priority }: { priority: 1 | 2 | 3 | null }) {
  const filled = priority == null ? 0 : 4 - priority;
  return (
    <span
      className="priority-bars"
      title={priority == null ? undefined : `Priority ${priority}`}
      aria-label={priority == null ? undefined : `Priority ${priority}`}
    >
      {[0, 1, 2].map((i) => (
        <span key={i} className={`bar${i < filled ? " filled" : ""}`} />
      ))}
    </span>
  );
}

// Controlled input that commits on Enter/blur, cancels on Escape.
// Focus lands at the end of the text (not a full select) so a click-to-edit
// appends naturally, like the notes textareas. Shared with Goals.tsx.
export function EditInput({  initial, onCommit,
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

// The task's details body — the spec under the one-line title, and for agent-
// delegated rows the prompt an autonomous session executes (readable via
// `dayapp --task`). Rendered by SectionView as a sibling under the open row
// (like the tier dividers — never inside the dragged row). Auto-growing
// textarea with debounced autosave, the Notes pattern; Escape flushes and
// collapses. Content, not state: saves go through set_item_details and are
// never logged to `actions`.
export function ItemDetailsBody({
  initial, onCommit, onDone,
}: {
  initial: string;
  onCommit: (details: string) => void;
  onDone: () => void;
}) {
  const [val, setVal] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const savedRef = useRef(initial);

  // Auto-grow to content height (Notes pattern — no internal scrollbar).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [val]);

  useEffect(() => {
    ref.current?.focus();
    const el = ref.current;
    if (!el) return;
    const end = initial.length;
    el.setSelectionRange(end, end);
  }, [initial]);

  // Debounced autosave (600ms) once the value drifts from the last save.
  useEffect(() => {
    if (val === savedRef.current) return;
    const t = window.setTimeout(() => {
      savedRef.current = val;
      onCommit(val);
    }, 600);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [val]);

  const flush = () => {
    if (val === savedRef.current) return;
    savedRef.current = val;
    onCommit(val);
  };

  return (
    <div className="item-details">
      <textarea
        ref={ref}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={flush}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            flush();
            onDone();
          }
        }}
        placeholder="Details — context, constraints, definition of done. For agent tasks this is the prompt."
        spellCheck={false}
      />
    </div>
  );
}

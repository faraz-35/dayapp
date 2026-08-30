// ItemRow — a single task row: checkbox, text (or inline editor), metadata,
// and the hover-revealed action buttons (timer / promote / project / reminder /
// hide / details / delete). Drag handle is the ⠿ grip; DnD is wired by the
// parent via useSortable. The buttons carry data-kb markers (1-6, visual
// order) so the focus grammar's digits fire them through their real onClick
// handlers. Slot 1 is section-dependent: ▶ timer on Today/Daily, ↑ send to
// Today on the Backlog (⏸ stop on whichever row is timing).
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

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { formatDuration, formatLiveDuration, formatReminder, localDateStr, projectColor, type HideDuration, type Item, type Project, type TokenKind } from "../lib";
import HideMenu from "../HideMenu";
import ProjectMenu from "../ProjectMenu";
import ReminderMenu from "../ReminderMenu";
import TokenField from "../TokenField";
import { PriorityBars } from "./PriorityBars";

export default function ItemRow({
  item, projects, selected, editing, detailsOpen,
  onSelect, onComplete, onDelete, onCommitEdit, onStartEdit, onHide, onUnhide,
  onSetProject, onCreateProject, onSetReminder, onToggleDetails, onToggleTimer, onPromote, isTiming, elapsedSec, totalSec,
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
  /** Send to Today (Backlog rows only) — slot 1's verb there. */
  onPromote: () => void;
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
        <EditInput
          initial={item.text}
          onCommit={onCommitEdit}
          kinds={["project", "priority", "agent"]}
        />
      ) : (
        <span className="item-text">{item.text}</span>
      )}

      {/* Right-aligned metadata. Three identity axes — agent, priority,
          project — render as FIXED COLUMNS (empty slot when a row lacks the
          axis, the project slot sized to the roster's widest name via
          --project-col), so the metadata reads as one aligned block down the
          list. The transient facts (hidden status, tracked time, reminder)
          flow left of the columns and fade on hover, yielding to the buttons.
          Robot + priority + project stay visible on hover (the row's
          identity, wanted while its actions are on screen). Suppressed while
          timing — the live elapsed then lives in the action cluster
          instead. */}
      {!editing && !isTiming && (item.hidden || totalSec > 0 || project || item.remindAt || priorityBars || item.assignedToAgent) && (
        <div className="item-meta">
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
          {item.remindAt && (
            <span className="reminder-chip" title={`Reminds on ${item.remindAt}`}>
              → {formatReminder(item.remindAt)}
            </span>
          )}
          <span className="meta-agent">{item.assignedToAgent && <AgentBadge />}</span>
          <span className="meta-priority">{priorityBars}</span>
          <span className="meta-project">
            {project && (
              <span
                className="project-label"
                style={{ color: projectColor(project.id) }}
                title={`Project: ${project.name}`}
              >{project.name}</span>
            )}
          </span>
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
          {/* Slot 1 — the row's primary verb, in digit order. A timing row
              always shows ⏸: the one always-visible stop control outranks
              everything. Otherwise the Backlog's slot 1 is "send to Today" —
              pulling work into the day is the one action a shelved row
              offers; timing belongs to Today/Daily, where the work happens.
              A hidden row never starts anything, so it only ever shows the
              stop form. */}
          {(isTiming || !item.hidden) &&
            (isTiming ? (
              <button
                className="item-action timer-btn timing"
                data-kb="1"
                onClick={(e) => { e.stopPropagation(); onToggleTimer(); }}
                title="Stop timer"
                aria-label="Stop timer"
              >⏸</button>
            ) : item.section === "backlog" ? (
              <button
                className="item-action promote-btn"
                data-kb="1"
                onClick={(e) => { e.stopPropagation(); onPromote(); }}
                title="Send to Today"
                aria-label="Send to Today"
              ><ArrowUp /></button>
            ) : (
              <button
                className="item-action timer-btn"
                data-kb="1"
                onClick={(e) => { e.stopPropagation(); onToggleTimer(); }}
                title="Start timer"
                aria-label="Start timer"
              >▶</button>
            ))}
          {item.hidden ? (
            <>
              <button
                className="item-action unhide-btn"
                data-kb="4"
                onClick={(e) => { e.stopPropagation(); onUnhide(); }}
                title="Unhide"
                aria-label="Unhide"
              >↺</button>
              <button
                className="item-action danger"
                data-kb="6"
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                title="Delete"
                aria-label="Delete"
              >×</button>
            </>
          ) : (
            <>
              <ProjectMenu
                kb="2"
                projects={projects}
                projectId={item.projectId}
                onAssign={onSetProject}
                onCreateProject={onCreateProject}
              />
              <ReminderMenu kb="3" remindAt={item.remindAt} onSet={onSetReminder} />
              <HideMenu kb="4" onHide={onHide} />
              <button
                className={`item-action${detailsOpen ? " active" : ""}`}
                data-kb="5"
                onClick={(e) => { e.stopPropagation(); onToggleDetails(); }}
                title={detailsOpen
                  ? "Collapse details"
                  : item.details
                    ? "Expand details"
                    : "Add details — the task's spec (for agent tasks, the prompt)"}
                aria-label={detailsOpen ? "Collapse details" : item.details ? "Expand details" : "Add details"}
              >{detailsOpen ? <Chevron up /> : item.details ? <Chevron /> : "⋯"}</button>
              <button
                className="item-action danger"
                data-kb="6"
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
      <svg viewBox="0 0 12 12" width="13" height="13" aria-hidden="true">
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

// The Backlog's send-to-Today arrow. Stroked SVG like the details chevron —
// same weight, centers in the 22×22 .item-action — rather than a unicode ↑,
// whose glyph metrics vary by font (the reason Chevron is drawn too).
function ArrowUp() {
  return (
    <svg
      className="action-chevron"
      viewBox="0 0 12 12"
      width="12"
      height="12"
      aria-hidden="true"
    >
      <path
        d="M6 9.4V2.6M3.2 5.4 6 2.6 8.8 5.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// The expand/collapse chevron for the details button. Drawn as SVG rather
// than the ⌄/⌃ unicode arrowheads — those fall back to an odd font and render
// at different sizes/baselines per direction; a stroked path is identical in
// both directions and centers exactly in the 22×22 .item-action (flex).
function Chevron({ up }: { up?: boolean }) {
  return (
    <svg
      className="action-chevron"
      viewBox="0 0 12 12"
      width="12"
      height="12"
      aria-hidden="true"
    >
      <path
        d={up ? "M2.8 7.6 6 4.4 9.2 7.6" : "M2.8 4.4 6 7.6 9.2 4.4"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Controlled input that commits on Enter/blur, cancels on Escape.
// Focus lands at the end of the text (not a full select) so a click-to-edit
// appends naturally, like the notes textareas. Shared with Goals.tsx and
// Journal.tsx. With `kinds` set it renders as a TokenField so the edit colors
// the tokens its commit will parse (task edits carry the full grammar, goal
// edits the #tag); without it, the plain input — the surface parses nothing
// (Journal entries are stored verbatim).
export function EditInput({ initial, onCommit, kinds }: {
  initial: string;
  onCommit: (text: string) => void;
  kinds?: readonly TokenKind[];
}) {
  const [val, setVal] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const end = initial.length;
    el.setSelectionRange(end, end);
  }, [initial]);
  // Clicks must not fall through to the row's select+edit handler, and the
  // commit rules are the same whichever field renders.
  const handlers = {
    onClick: (e: { stopPropagation: () => void }) => e.stopPropagation(),
    onBlur: () => onCommit(val),
    // The union element keeps one handler assignable to both fields — the
    // plain input and TokenField's input-or-textarea.
    onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === "Enter") { e.preventDefault(); onCommit(val); }
      if (e.key === "Escape") onCommit(initial);
    },
  };
  return kinds ? (
    <TokenField
      ref={ref}
      className="item-edit"
      kinds={kinds}
      value={val}
      onChange={setVal}
      {...handlers}
    />
  ) : (
    <input
      ref={ref}
      className="item-edit"
      value={val}
      onChange={(e) => setVal(e.target.value)}
      {...handlers}
    />
  );
}

// The task's details body — the main content opened under the headline row,
// full width and full-strength: the expanded task reads as a small document,
// not an attachment. For agent-delegated rows it's the prompt an autonomous
// session executes (readable via `dayapp --task`). Rendered by SectionView as
// a sibling under the open row (like the tier dividers — never inside the
// dragged row). Auto-growing textarea with debounced autosave, the Notes
// pattern; Escape flushes and collapses. Content, not state: saves go through
// set_item_details and are never logged to `actions`.
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
      {/* Leading slots mirror the row's own structure (grip glyph + checkbox
          slot + the 8px gaps, same container padding) so the body's text
          starts exactly under .item-text and its focus background spans the
          exact box a hovered row's background does — one grid, not two. */}
      <span className="grip" aria-hidden="true">⠿</span>
      <span className="details-slot" aria-hidden="true" />
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
        placeholder="Add context, constraints, done-criteria…"
        spellCheck={false}
      />
    </div>
  );
}

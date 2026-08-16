// Notes — self-contained component for free-form multiline text.
// Renders at the top of the main view for minimum inertia. Each note is an
// auto-growing textarea that autosaves (debounced) and saves on blur.
//
// Hover reveal (hide/delete buttons) is JS-tracked rather than CSS :hover —
// see the pointer effect below for why. Deliberately isolated from the
// items/actions feature: own state, own API, own handlers. The parent passes
// the ⌘P visibility mode as a HiddenFilter — "include"/"only" render hidden
// notes inline (dimmed, ↺ to restore) instead of excluding them.
//
// Each note card can be collapsed to a single line — its first non-empty
// line. The card shrinks in place (same look, just shorter; no layout
// swap), and the collapsed card is one big click target: expanding focuses
// its textarea with the caret at the end, so collapsed → editing is one
// click. Which notes are collapsed persists in localStorage; deliberately
// no keybinding — a minor action gets a small button (⌃ in the card's hover
// actions), not a key.

import { useCallback, useEffect, useRef, useState } from "react";
import { notesApi, type Note } from "./notesApi";
import { type HideDuration, type HiddenFilter } from "./lib";
import HideMenu from "./HideMenu";

// Collapsed-note ids, persisted like the UI zoom — a display preference.
// localStorage only: collapse is UI state, not content, so the notes table
// stays untouched.
const COLLAPSED_KEY = "dayapp-notes-collapsed";

export default function Notes({ hiddenFilter }: { hiddenFilter: HiddenFilter }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [draft, setDraft] = useState("");
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
      return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
    } catch {
      return new Set();
    }
  });
  // The note whose action buttons are revealed. Tracked in JS instead of
  // CSS :hover — see the pointer effect below.
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // ---- Hover tracking -----------------------------------------------------
  // WKWebKit's :hover chain goes stale when the layout shifts under a
  // stationary pointer: the auto-growing note textareas resize on every
  // keystroke, and WebKit doesn't reliably re-evaluate :hover after those
  // mutations (or after scrolling), so a note the pointer has already left
  // keeps showing its hide/delete buttons. Item rows never resize, which is
  // why they don't hit this. Deriving the hovered note from the real pointer
  // position is immune: every delivered mousemove recomputes it, and
  // scroll/input events re-derive it via elementFromPoint for shifts that
  // happen without any mousemove at all.
  useEffect(() => {
    let x = -1;
    let y = -1; // last delivered pointer position; -1 = never seen

    const idAtPoint = () => {
      const el = document.elementFromPoint(x, y);
      return el?.closest(".note")?.getAttribute("data-note-id") ?? null;
    };

    const onMove = (e: MouseEvent) => {
      x = e.clientX;
      y = e.clientY;
      const id = e.target instanceof Element
        ? e.target.closest(".note")?.getAttribute("data-note-id") ?? null
        : null;
      // Bail out unless the pointer crossed a note boundary, so the list
      // doesn't re-render on every mousemove.
      setHoveredId((prev) => (prev === id ? prev : id));
    };

    // Content moved under a stationary pointer — a scroll, or a textarea
    // elsewhere in the list auto-resizing on input. No mousemove fires, so
    // re-derive from the last known position.
    const reconcile = () => setHoveredId((prev) => {
      const id = idAtPoint();
      return prev === id ? prev : id;
    });

    // Pointer left the webview (window edge, or up into the header's drag
    // region where mouse events stop being delivered) — no further mousemove
    // would clear the reveal, so clear it eagerly.
    const onOut = (e: MouseEvent) => { if (!e.relatedTarget) setHoveredId(null); };
    const onBlur = () => setHoveredId(null);

    window.addEventListener("mousemove", onMove);
    window.addEventListener("scroll", reconcile, true);
    window.addEventListener("input", reconcile);
    document.addEventListener("mouseout", onOut);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("scroll", reconcile, true);
      window.removeEventListener("input", reconcile);
      document.removeEventListener("mouseout", onOut);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const refresh = useCallback(async () => {
    const list = await notesApi.list(hiddenFilter);
    setNotes(list);
  }, [hiddenFilter]);

  useEffect(() => { refresh(); }, [refresh]);

  // Type + Enter creates a real note at the bottom of the list. The capture
  // field stays open for the next note, so capture stays zero-inertia.
  const handleCreate = async (body: string) => {
    const note = await notesApi.create(body);
    setNotes((s) => [...s, note]);
  };

  const handleUpdate = useCallback(async (id: string, body: string) => {
    // Optimistic local update; debounce is in the textarea component.
    setNotes((s) => s.map((n) => (n.id === id ? { ...n, body } : n)));
    await notesApi.update(id, body);
  }, []);

  // Collapse/expand a note card in place. Persisted so a relaunch keeps the
  // list as compact as the user left it.
  const toggleCollapse = (id: string) => {
    const next = new Set(collapsedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setCollapsedIds(next);
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
  };

  const handleDelete = async (id: string) => {
    setNotes((s) => s.filter((n) => n.id !== id));
    // Prune the dead id so the persisted collapse set doesn't accumulate.
    if (collapsedIds.has(id)) toggleCollapse(id);
    await notesApi.delete(id);
  };

  // Soft-archive a note. In a view that shows hidden entries it stays put,
  // flipped to its dimmed hidden state; in Regular mode it leaves the list.
  // Time-limited hides auto-restore at the day boundary.
  const handleHide = async (id: string, duration: HideDuration) => {
    if (hiddenFilter === "exclude") setNotes((s) => s.filter((n) => n.id !== id));
    else setNotes((s) => s.map((n) => (n.id === id ? { ...n, hidden: true } : n)));
    await notesApi.hide(id, duration);
  };

  // Restore a hidden note. In hidden-only mode it leaves the view (a restored
  // note isn't hidden anymore); in Show All it just sheds its dimmed state.
  const handleUnhide = async (id: string) => {
    if (hiddenFilter === "only") setNotes((s) => s.filter((n) => n.id !== id));
    else setNotes((s) => s.map((n) => (n.id === id ? { ...n, hidden: false } : n)));
    await notesApi.unhide(id);
  };

  return (
    <section className="notes">
      <div className="section-head">
        <span className="section-name">Notes</span>
      </div>

      {/* Always-open capture: type + Enter writes a note. No + button.
          Suppressed in hidden-only mode — a fresh note isn't hidden, so it
          would vanish from the view the moment it's created. */}
      {hiddenFilter !== "only" && (
        <div className="capture">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                const t = draft.trim();
                if (t) {
                  handleCreate(t);
                  setDraft("");
                }
              }
              if (e.key === "Escape") setDraft("");
            }}
            rows={3}
            spellCheck={false}
          />
        </div>
      )}

      {notes.map((note) => (
        <NoteInput
          key={note.id}
          note={note}
          hovered={hoveredId === note.id}
          collapsed={collapsedIds.has(note.id)}
          onToggleCollapse={() => toggleCollapse(note.id)}
          onUpdate={handleUpdate}
          onDelete={() => handleDelete(note.id)}
          onHide={(duration) => handleHide(note.id, duration)}
          onUnhide={() => handleUnhide(note.id)}
        />
      ))}
    </section>
  );
}

// ---- Single note textarea ------------------------------------------------

function NoteInput({
  note, hovered, collapsed, onToggleCollapse, onUpdate, onDelete, onHide, onUnhide,
}: {
  note: Note;
  hovered: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onUpdate: (id: string, body: string) => void;
  onDelete: () => void;
  onHide: (duration: HideDuration) => void;
  onUnhide: () => void;
}) {
  const [val, setVal] = useState(note.body);
  const ref = useRef<HTMLTextAreaElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestBody = useRef(note.body);

  // Expanding puts the caret at the end of the textarea — the collapsed card
  // is a one-click path back to editing. Skipped on mount.
  const wasCollapsed = useRef(collapsed);
  useEffect(() => {
    if (wasCollapsed.current && !collapsed) {
      ref.current?.focus();
      ref.current?.setSelectionRange(val.length, val.length);
    }
    wasCollapsed.current = collapsed;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed]);

  // Keep local state in sync if the note changes externally.
  useEffect(() => {
    if (latestBody.current !== note.body) {
      setVal(note.body);
      latestBody.current = note.body;
      autosize();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.body]);

  // Grow the textarea to fit content (no internal scrollbar for short notes).
  const autosize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight, 28)}px`;
  };

  useEffect(() => { autosize(); }, []);

  const scheduleSave = (body: string) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => onUpdate(note.id, body), 600);
  };

  return (
    <div
      className={`note${collapsed ? " collapsed" : ""}${hovered ? " hovered" : ""}${note.hidden ? " hidden" : ""}`}
      data-note-id={note.id}
      // The collapsed card is one big click target: expand + caret at end.
      onClick={collapsed ? onToggleCollapse : undefined}
      title={collapsed ? "Expand note" : undefined}
    >
      {collapsed ? (
        <div className="note-preview">
          {val.split("\n").find((l) => l.trim().length > 0)?.trim() ?? ""}
        </div>
      ) : (
        <textarea
          ref={ref}
          className="note-textarea"
          value={val}
          onChange={(e) => {
            setVal(e.target.value);
            autosize();
            scheduleSave(e.target.value);
          }}
          onBlur={() => {
            if (saveTimer.current) {
              clearTimeout(saveTimer.current);
              saveTimer.current = null;
            }
            // Save immediately on blur.
            onUpdate(note.id, val);
          }}
          placeholder="Write or paste anything…"
          spellCheck={false}
        />
      )}
      <div
        className="note-actions"
        // Action clicks must not fall through to the collapsed card's
        // expand-on-click — only its content area expands.
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="item-action"
          onClick={onToggleCollapse}
          title={collapsed ? "Expand note" : "Collapse note"}
          aria-label={collapsed ? "Expand note" : "Collapse note"}
        >{collapsed ? "⌄" : "⌃"}</button>
        {/* Hidden notes swap the ◐ hide menu for ↺ restore, mirroring hidden
            item rows in Show-All mode. */}
        {note.hidden ? (
          <button
            className="item-action unhide-btn"
            onClick={onUnhide}
            title="Unhide note"
            aria-label="Unhide note"
          >↺</button>
        ) : (
          <HideMenu onHide={onHide} />
        )}
        {val.trim() && (
          <button
            className="note-delete"
            onClick={onDelete}
            title="Delete note"
            aria-label="Delete note"
          >×</button>
        )}
      </div>
    </div>
  );
}

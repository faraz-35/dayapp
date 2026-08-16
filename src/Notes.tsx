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
// The surface can be minimized to one line (the NOTES label + the first line
// of the first note). The minimized flag itself lives in App (the `n`
// keybinding toggles it); expanding focuses the capture field, so the hop
// from minimized back to writing is a single click.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { notesApi, type Note } from "./notesApi";
import { type HideDuration, type HiddenFilter } from "./lib";
import HideMenu from "./HideMenu";

export default function Notes({
  hiddenFilter, minimized, onToggleMinimized,
}: {
  hiddenFilter: HiddenFilter;
  minimized: boolean;
  onToggleMinimized: () => void;
}) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [draft, setDraft] = useState("");
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

  const handleDelete = async (id: string) => {
    setNotes((s) => s.filter((n) => n.id !== id));
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

  // The collapsed bar's content: the first non-empty line of the first note
  // in the rendered list — a preview of what expanding would show.
  const preview = useMemo(() => {
    for (const n of notes) {
      const line = n.body.split("\n").find((l) => l.trim().length > 0);
      if (line) return line.trim();
    }
    return null;
  }, [notes]);

  // Expanding puts the caret at the end of the capture field — minimized →
  // writing is one click. Skipped on mount so a fresh launch doesn't steal
  // focus from j/k nav. (No capture in hidden-only mode; then just expand.)
  const captureRef = useRef<HTMLTextAreaElement>(null);
  const wasMinimized = useRef(minimized);
  useEffect(() => {
    if (wasMinimized.current && !minimized) {
      const el = captureRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }
    wasMinimized.current = minimized;
  }, [minimized]);

  return (
    <section className="notes">
      {minimized ? (
        /* The whole collapsed surface is the expand control: one click (or
           `n`) opens Notes with the capture field focused. */
        <button
          className="notes-collapsed"
          onClick={onToggleMinimized}
          title="Expand notes (n)"
        >
          <span className="section-name">Notes</span>
          {preview && <span className="notes-collapsed-preview">{preview}</span>}
          <span className="notes-collapsed-chevron" aria-hidden="true">⌄</span>
        </button>
      ) : (
        <div className="section-head notes-head">
          <span className="section-name">Notes</span>
          <button
            className="notes-minimize"
            onClick={onToggleMinimized}
            title="Minimize notes (n)"
            aria-label="Minimize notes"
          >⌃</button>
        </div>
      )}

      {/* Always-open capture: type + Enter writes a note. No + button.
          Suppressed in hidden-only mode — a fresh note isn't hidden, so it
          would vanish from the view the moment it's created. */}
      {hiddenFilter !== "only" && (
        <div className="capture">
          <textarea
            ref={captureRef}
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
  note, hovered, onUpdate, onDelete, onHide, onUnhide,
}: {
  note: Note;
  hovered: boolean;
  onUpdate: (id: string, body: string) => void;
  onDelete: () => void;
  onHide: (duration: HideDuration) => void;
  onUnhide: () => void;
}) {
  const [val, setVal] = useState(note.body);
  const ref = useRef<HTMLTextAreaElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestBody = useRef(note.body);

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
      className={`note${hovered ? " hovered" : ""}${note.hidden ? " hidden" : ""}`}
      data-note-id={note.id}
    >
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
      <div className="note-actions">
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

// Notes — self-contained component for free-form multiline text.
// Renders at the top of the main view for minimum inertia. Each note is an
// auto-growing textarea that autosaves (debounced) and saves on blur.
//
// Deliberately isolated from the items/actions feature: own state, own API,
// own handlers. The parent just mounts <Notes />.

import { useCallback, useEffect, useRef, useState } from "react";
import { notesApi, type Note } from "./notesApi";
import { type HideDuration } from "./lib";
import HideMenu from "./HideMenu";

export default function Notes() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [draft, setDraft] = useState("");

  const refresh = useCallback(async () => {
    const list = await notesApi.list();
    setNotes(list);
  }, []);

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

  // Soft-archive a note. Optimistically removed; reappears via the Hidden view,
  // and time-limited hides auto-restore at the day boundary.
  const handleHide = async (id: string, duration: HideDuration) => {
    setNotes((s) => s.filter((n) => n.id !== id));
    await notesApi.hide(id, duration);
  };

  return (
    <section className="notes">
      <div className="section-head">
        <span className="section-name">Notes</span>
        <span className="section-count">{notes.length || ""}</span>
      </div>

      {/* Always-open capture: type + Enter writes a note. No + button. */}
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
          rows={1}
          spellCheck={false}
        />
      </div>

      {notes.map((note) => (
        <NoteInput
          key={note.id}
          note={note}
          onUpdate={handleUpdate}
          onDelete={() => handleDelete(note.id)}
          onHide={(duration) => handleHide(note.id, duration)}
        />
      ))}
    </section>
  );
}

// ---- Single note textarea ------------------------------------------------

function NoteInput({
  note, onUpdate, onDelete, onHide,
}: {
  note: Note;
  onUpdate: (id: string, body: string) => void;
  onDelete: () => void;
  onHide: (duration: HideDuration) => void;
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
    <div className="note">
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
        <HideMenu onHide={onHide} />
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

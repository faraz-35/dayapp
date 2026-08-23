// Notes — self-contained component for free-form multiline text.
// Renders at the top of the main view for minimum inertia. Each note is an
// auto-growing textarea that autosaves (debounced) and saves on blur.
//
// Hover reveal (hide/delete buttons) is JS-tracked rather than CSS :hover —
// see the pointer effect below for why. Deliberately isolated from the
// items/actions feature: own state, own API, own handlers. The parent passes a
// HiddenFilter — "include" (⌘P → Show Hidden Notes) renders hidden notes
// inline (dimmed, ↺ to restore) instead of excluding them.
//
// Each note card can be collapsed to a single line — its first non-empty
// line. The card shrinks in place (same look, just shorter; no layout
// swap), and the collapsed card is one big click target: expanding focuses
// its textarea with the caret at the end, so collapsed → editing is one
// click. Which notes are collapsed persists in localStorage; no dedicated
// key — the focus grammar reaches it as digit 1 on a focused note.
//
// Two note-local verbs ride the same card: ⬇ exports the body as a .txt
// through the native save panel (slot 2 on a focused note), and ⌘F while a
// note's textarea has focus opens a find bar scoped to that note — the
// global item search only owns ⌘F elsewhere. Both live here, not in App:
// the note owns its text, and both verbs are entirely about it.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { notesApi, type Note } from "./notesApi";
import { type HideDuration, type HiddenFilter } from "./lib";
import { log } from "./log";
import HideMenu from "./HideMenu";

// Collapsed-note ids, persisted like the UI zoom — a display preference.
// localStorage only: collapse is UI state, not content, so the notes table
// stays untouched.
const COLLAPSED_KEY = "dayapp-notes-collapsed";

export default function Notes({ hiddenFilter, focusedId, reloadEpoch = 0 }: { hiddenFilter: HiddenFilter; focusedId?: string | null; reloadEpoch?: number }) {
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
  // The note whose local find bar is open (⌘F while its textarea has focus).
  // Which note is all the parent owns — the query and match index live in the
  // note's own component, beside the text they're computed against.
  const [findId, setFindId] = useState<string | null>(null);

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

  // reloadEpoch bumps when the whole database is swapped under the app (demo
  // mode toggle/reset) — refetch alongside the hiddenFilter-driven reloads.
  // A swap orphans any open find bar's ids; close it with the same brush.
  useEffect(() => { refresh(); setFindId(null); }, [refresh, reloadEpoch]);

  // ⌘F is note-local while a note is being edited: the textarea (or the find
  // bar's own input) has focus → open/find-again in that note instead of App's
  // global item search. Listened in the capture phase so it outruns App's
  // bubble-phase ⌘F; stopPropagation keeps the global search from opening too.
  // Anywhere else — a task row, an item edit, nothing focused — ⌘F stays the
  // global search, unchanged.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "f") return;
      const el = document.activeElement;
      const local =
        el instanceof HTMLTextAreaElement && el.classList.contains("note-textarea")
          ? el
          : el instanceof HTMLElement && el.classList.contains("note-find-input")
            ? el
            : null;
      const id = local?.closest("[data-note-id]")?.getAttribute("data-note-id");
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      setFindId(id);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

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
            data-capture="notes"
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
              // Empty draft → blur instead: the Esc ladder's editing →
              // nothing rung for captures (there's no focused-thing state
              // between — a capture input isn't one of the grammar's targets).
              if (e.key === "Escape") {
                if (draft) setDraft("");
                else e.currentTarget.blur();
              }
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
          focused={focusedId === note.id}
          collapsed={collapsedIds.has(note.id)}
          findOpen={findId === note.id}
          onToggleCollapse={() => toggleCollapse(note.id)}
          onUpdate={handleUpdate}
          onDelete={() => handleDelete(note.id)}
          onHide={(duration) => handleHide(note.id, duration)}
          onUnhide={() => handleUnhide(note.id)}
          onFindClose={() => setFindId(null)}
        />
      ))}
    </section>
  );
}

// ---- Single note textarea ------------------------------------------------

function NoteInput({
  note, hovered, focused, collapsed, findOpen, onToggleCollapse, onUpdate, onDelete, onHide, onUnhide, onFindClose,
}: {
  note: Note;
  hovered: boolean;
  focused: boolean;
  collapsed: boolean;
  /** ⌘F while this note was being editing opened its local find bar. */
  findOpen: boolean;
  onToggleCollapse: () => void;
  onUpdate: (id: string, body: string) => void;
  onDelete: () => void;
  onHide: (duration: HideDuration) => void;
  onUnhide: () => void;
  onFindClose: () => void;
}) {
  const [val, setVal] = useState(note.body);
  const ref = useRef<HTMLTextAreaElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestBody = useRef(note.body);

  // ---- Find in this note (⌘F while editing it) ------------------------------
  // The query and match index live here, not in Notes, because the matches are
  // computed against the live `val` — only this component holds the text as
  // typed (the parent lags by the debounce). While the bar is open its input
  // owns focus; matches paint through a transparent-text mirror under the
  // textarea (a textarea can't tint ranges itself).

  const [findQuery, setFindQuery] = useState("");
  const [findIdx, setFindIdx] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);

  // Case-insensitive substring matches as [start, end) offsets into val.
  const matches = useMemo(() => {
    if (!findOpen || !findQuery) return [] as Array<[number, number]>;
    const hay = val.toLowerCase();
    const needle = findQuery.toLowerCase();
    const out: Array<[number, number]> = [];
    let i = hay.indexOf(needle);
    while (i !== -1) {
      out.push([i, i + needle.length]);
      i = hay.indexOf(needle, i + needle.length);
    }
    return out;
  }, [findOpen, findQuery, val]);

  // The render-time index: a query or text edit can shrink the match set
  // below the stored one, so clamp before every use.
  const cur = Math.min(findIdx, Math.max(0, matches.length - 1));

  // Step with wraparound, the way every find bar works.
  const step = (delta: number) => {
    if (matches.length === 0) return;
    setFindIdx((i) => (Math.min(i, matches.length - 1) + delta + matches.length) % matches.length);
  };

  // Opening the bar focuses (and selects, so retyping replaces) the query
  // field; the query itself persists per note across opens.
  useEffect(() => {
    if (!findOpen) return;
    setFindIdx(0);
    const el = findInputRef.current;
    if (el) { el.focus(); el.select(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen]);

  // Keep the current match on screen as the index or query moves. Instant,
  // not smooth — match stepping is a jump-verb, like caret moves.
  useEffect(() => {
    if (!findOpen || matches.length === 0) return;
    document.querySelector(`[data-note-id="${note.id}"] .note-find-cur`)
      ?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, cur, findQuery, note.id]);

  // Close and hand editing back where the bar landed: the textarea focuses
  // with the current match selected, so the visible selection continues the
  // read from exactly what was highlighted.
  const closeFind = () => {
    onFindClose();
    const ta = ref.current;
    if (!ta) return;
    ta.focus();
    const m = matches[cur];
    if (m) ta.setSelectionRange(m[0], m[1]);
    else ta.setSelectionRange(ta.value.length, ta.value.length);
  };

  // Export the body as a .txt through the native save panel. The name seeds
  // from the first non-empty line — the same line the collapsed preview shows
  // — so the file is recognizable in Finder without opening it.
  const handleDownload = async () => {
    // Flush any debounced edit first: the file should match what's on screen.
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      onUpdate(note.id, val);
    }
    try {
      await notesApi.saveAs(exportName(val), val);
    } catch (e) {
      log.warn("notes: export failed", e);
    }
  };

  // Grow the textarea to fit content (no internal scrollbar for short notes).
  const autosize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight, 28)}px`;
  };

  // Expanding puts the caret at the end of the textarea — the collapsed card
  // is a one-click path back to editing. The textarea (re)mounts with the
  // expand (it's swapped for the preview div while collapsed), and the []
  // mount effect below ran at the note's original mount, not the textarea's —
  // so size it here or it opens at the browser default ~2 rows until the
  // first keystroke. Skipped on mount itself.
  const wasCollapsed = useRef(collapsed);
  useEffect(() => {
    if (wasCollapsed.current && !collapsed) {
      autosize();
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

  useEffect(() => { autosize(); }, []);

  const scheduleSave = (body: string) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => onUpdate(note.id, body), 600);
  };

  // The mirror's children: val split at match boundaries, each match a <mark>
  // (the current one distinct). Rendered only while finding — zero cost to
  // the normal editing path.
  const mirrorNodes = useMemo(() => {
    if (!findOpen || matches.length === 0) return null;
    // A trailing newline collapses at the mirror's block end (the textarea
    // still reserves the line); a zero-width tail makes the mirror take it.
    const tail = val.endsWith("\n") ? "\u200b" : "";
    const parts: ReactNode[] = [];
    let pos = 0;
    matches.forEach(([s, e], i) => {
      if (s > pos) parts.push(val.slice(pos, s));
      parts.push(
        <mark key={i} className={i === cur ? "note-find-cur" : undefined}>
          {val.slice(s, e)}
        </mark>,
      );
      pos = e;
    });
    parts.push(val.slice(pos) + tail);
    return parts;
  }, [findOpen, matches, cur, val]);

  return (
    <div
      className={`note${collapsed ? " collapsed" : ""}${hovered ? " hovered" : ""}${focused ? " focused" : ""}${note.hidden ? " hidden" : ""}${findOpen && !collapsed ? " finding" : ""}`}
      data-note-id={note.id}
      // The collapsed card is one big click target: expand + caret at end.
      onClick={collapsed ? onToggleCollapse : undefined}
      title={collapsed ? "Expand note" : undefined}
    >
      {/* The note-local find bar (⌘F while editing). Inline chrome on the card
          while it lasts — it belongs to the note, not the page. Enter / ↓ and
          ↑ / ⇧Enter step matches (arrows, not letters, in a text field);
          Escape closes and hands the caret back at the current match. */}
      {findOpen && !collapsed && (
        <div className="note-find">
          <input
            ref={findInputRef}
            className="note-find-input"
            value={findQuery}
            placeholder="Find in note"
            spellCheck={false}
            onChange={(e) => { setFindQuery(e.target.value); setFindIdx(0); }}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(); }
              else if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); step(-1); }
              else if (e.key === "Enter" || e.key === "ArrowDown") { e.preventDefault(); step(1); }
              else if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
            }}
          />
          <span className="note-find-count">
            {findQuery ? (matches.length > 0 ? `${cur + 1}/${matches.length}` : "0/0") : ""}
          </span>
          <button className="note-find-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => step(-1)} title="Previous match (↑)"><FindChevron up /></button>
          <button className="note-find-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => step(1)} title="Next match (Enter)"><FindChevron /></button>
          <button className="note-find-btn" onMouseDown={(e) => e.preventDefault()} onClick={closeFind} title="Close (Esc)">×</button>
        </div>
      )}
      {collapsed ? (
        <div className="note-preview">
          {val.split("\n").find((l) => l.trim().length > 0)?.trim() ?? ""}
        </div>
      ) : (
        <div className="note-body-wrap">
          {/* The match highlight: a transparent-text copy of the body laid out
              exactly under the textarea (same font/wrap — see .note-mirror in
              index.css), marks tinted through it. pointer-events: none in CSS,
              so it never intercepts the editor. */}
          {mirrorNodes !== null && (
            <div className="note-mirror" aria-hidden="true">{mirrorNodes}</div>
          )}
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
            // Esc ladder: find bar → editing → focused. Blur flushes the
            // debounced save; the note keeps its focus highlight (App's
            // focusNoteId) so the digits still act on it; a second Esc clears
            // that.
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                if (findOpen) { e.preventDefault(); e.stopPropagation(); onFindClose(); }
                else e.currentTarget.blur();
              }
            }}
            placeholder="Write or paste anything…"
            spellCheck={false}
          />
        </div>
      )}
      <div
        className="note-actions"
        // Action clicks must not fall through to the collapsed card's
        // expand-on-click — only its content area expands.
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="item-action"
          data-kb="1"
          onClick={onToggleCollapse}
          title={collapsed ? "Expand note" : "Collapse note"}
          aria-label={collapsed ? "Expand note" : "Collapse note"}
        >{collapsed ? "⌄" : "⌃"}</button>
        {/* ⬇ exports the body as a .txt via the native save panel — slot 2 on
            a focused note. Only for notes with content, like the delete slot;
            hidden notes skip it entirely (their slots are restore/delete
            only). */}
        {!note.hidden && val.trim() && (
          <button
            className="item-action"
            data-kb="2"
            onClick={handleDownload}
            title="Download as .txt"
            aria-label="Download as .txt"
          ><DownloadIcon /></button>
        )}
        {/* Hidden notes swap the ◐ hide menu for ↺ restore, mirroring hidden
            item rows in Show-All mode. The digits anchor to the slots the way
            ItemRow's hidden rows do: restore occupies the hide slot (3), delete
            keeps its own slot (4) — so the same digit means the same verb on a
            hidden or visible note. */}
        {note.hidden ? (
          <button
            className="item-action unhide-btn"
            data-kb="3"
            onClick={onUnhide}
            title="Unhide note"
            aria-label="Unhide note"
          >↺</button>
        ) : (
          <HideMenu kb="3" onHide={onHide} />
        )}
        {val.trim() && (
          <button
            className="note-delete"
            data-kb="4"
            onClick={onDelete}
            title="Delete note"
            aria-label="Delete note"
          >×</button>
        )}
      </div>
    </div>
  );
}

// A filesystem-safe .txt name from the note's first non-empty line — the same
// line the collapsed preview shows, so an export names itself the way the note
// reads in the list. Empty notes fall back to "note".
const exportName = (body: string) => {
  const first = body.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const base = first
    .replace(/[/\\:?*"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return base && /\.txt$/i.test(base) ? base : `${base || "note"}.txt`;
};

// The export glyph — an arrow into a tray, stroked SVG in the same family as
// ItemRow's chevron/arrow (unicode ⬇ rides the font's baseline and sizes
// inconsistently across it).
function DownloadIcon() {
  return (
    <svg className="action-chevron" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path
        d="M6 1.9v5.4M3.4 5.1 6 7.7 8.6 5.1M2.6 10.4h6.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Prev/next-match chevrons for the find bar — the details chevron's geometry,
// a size down for the smaller buttons.
function FindChevron({ up }: { up?: boolean }) {
  return (
    <svg className="action-chevron" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
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

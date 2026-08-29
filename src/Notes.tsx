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
// Notes carry the items' priority/project axes through the same token grammar,
// generalized to multi-line bodies: in the capture field the tokens sit inline
// (exactly item capture — parsed and stripped, `@` excepted), and in an
// existing note you type them on their own final line after a blank line. The
// tokens are input syntax, never stored or rendered — on blur the line is
// caught: stripped from the body and applied to the note's columns (no token
// leaves current values alone; `!0` clears priority, `#0` clears project).
// The list groups by tier the way the Backlog does — P1 → P3 → unmarked under
// tier dividers labeled with the bars; the cards themselves carry no bars (the
// sections are the tier signal) and no metadata chrome at all beyond the
// collapsed card's project label (right-aligned, the row language). The parent
// narrows the list with the ⌘P note-tier toggles, the ⌘F `#` project filter,
// and Focus Mode (P1 notes only), the same displayItems pipeline the sections
// use.
//
// Each note card can be collapsed to a single line — its first non-empty
// prose line (the footer never previews). The card shrinks in place (same
// look, just shorter; no layout swap), and the collapsed card is one big
// click target: expanding focuses its textarea with the caret at the end, so
// collapsed → editing is one click. Which notes are collapsed persists in
// localStorage; no dedicated key — the focus grammar reaches it as digit 1 on
// a focused note.
//
// Two note-local verbs ride the same card: ⬇ exports the body as a .txt
// through the native save panel (slot 2 on a focused note), and ⌘F while a
// note's textarea has focus opens a find bar scoped to that note — the
// global item search only owns ⌘F elsewhere. Both live here, not in App:
// the note owns its text, and both verbs are entirely about it.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { notesApi, type Note } from "./notesApi";
import { type EntryKind, type HideDuration, type HiddenFilter, baseTextWidth, entriesApi, parseEntryCapture, parseNoteCapture, projectColor, resolveNoteTag, scanNoteFooterTokens, splitNoteFooter, type Project } from "./lib";
import { log } from "./log";
import HideMenu from "./HideMenu";
import TokenField from "./TokenField";
import { PriorityBars } from "./components/PriorityBars";

// Collapsed-note ids, persisted like the UI zoom — a display preference.
// localStorage only: collapse is UI state, not content, so the notes table
// stays untouched.
const COLLAPSED_KEY = "dayapp-notes-collapsed";

// The notes' display order, mirroring list_notes' ORDER BY (notes.rs): priority
// tier first (unmarked last), then manual order — the Backlog's ordering. Saves
// return the re-derived row, so re-applying this keeps the optimistic list
// identical to what the next refresh returns (a note whose footer edit moved it
// across tiers lands in its group immediately, not at the next 60s tick).
const sortNotes = (list: Note[]) =>
  [...list].sort(
    (a, b) =>
      (a.priority ?? 99) - (b.priority ?? 99) ||
      a.sortOrder - b.sortOrder ||
      a.createdAt.localeCompare(b.createdAt),
  );

export default function Notes({
  hiddenFilter, focusedId, reloadEpoch = 0, projects, projectFilter, hiddenPriorities, focusMode, onCreateProject, onEntryRouted,
}: {
  hiddenFilter: HiddenFilter;
  focusedId?: string | null;
  reloadEpoch?: number;
  /** App's projects list — the single source (like Goals). The collapsed card's
   *  project label renders from it; ids not in it simply show no label. */
  projects: Project[];
  /** ⌘F `#` picker: narrow notes to this project too (null = off) — the same
   *  filter that narrows the task sections, composed with the tiers below. */
  projectFilter: string | null;
  /** ⌘P → Show/Hide Priority N Notes: tiers in this list are hidden. */
  hiddenPriorities: (1 | 2 | 3)[];
  /** ⌘P → Focus Mode: only P1 notes show (the lens, not a toggle mutation). */
  focusMode: boolean;
  /** App's create-project path (its state is the single source, like Goals) —
   *  a footer/capture `#tag` that matches nothing creates its project through
   *  this, so the label renders immediately. */
  onCreateProject: (name: string) => Promise<Project>;
  /** Notified when a ##j/##q capture was routed to the entries table, so App
   *  can refresh surfaces it owns (the quote modal). The capture itself is done
   *  here — the notes bar IS the bus. */
  onEntryRouted?: (kind: EntryKind) => void;
}) {
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

  // The typed-capture router, run ahead of note creation: a leading `##j`/`##q`
  // line becomes an entry instead of a note — the notes bus's whole idea. A
  // bare token with no text is swallowed (no empty entries, no junk note).
  // Entry captures never touch the notes state; App hears about quotes via
  // onEntryRouted so the quote modal's pool refreshes.
  const handleCapture = (raw: string) => {
    const route = parseEntryCapture(raw);
    if (!route) {
      handleCreate(raw);
      return;
    }
    if (!route.text) return;
    entriesApi
      .add(route.kind, route.text)
      .then(() => onEntryRouted?.(route.kind))
      .catch((e) => log.error("entry capture failed", e));
  };

  // Type + Enter creates a real note. Inline `#tag`/`!N` tokens parse exactly
  // like task capture (`@` stays literal — notes have no delegation axis):
  // stripped from the body, applied through the setters, and the note lands in
  // its tier group right away via sortNotes — App.handleCreate's shape.
  const handleCreate = async (raw: string) => {
    const { text, projectId, createProjectName, priority } = parseNoteCapture(raw, projects);
    const note = await notesApi.create(text);
    const assignId = projectId ?? (createProjectName ? (await onCreateProject(createProjectName)).id : null);
    // !0 ("clear") is a no-op at capture — a fresh note has no priority yet.
    const tier = priority === null || priority === 0 ? null : priority;
    const patch: Partial<Note> = {};
    if (assignId) patch.projectId = assignId;
    if (tier) patch.priority = tier;
    setNotes((s) => sortNotes([...s, { ...note, ...patch }]));
    if (assignId) notesApi.setProject(note.id, assignId);
    if (tier) notesApi.setPriority(note.id, tier);
  };

  const handleUpdate = useCallback(async (id: string, body: string) => {
    // Optimistic local update; debounce is in the textarea component. Body
    // edits never touch the columns — only the token catch does.
    setNotes((s) => s.map((n) => (n.id === id ? { ...n, body } : n)));
    await notesApi.update(id, body);
  }, []);

  // The blur-catch: a trailing token line (blank line + `!N`/`#tag`-only last
  // line) applies to the columns and vanishes from the body — the note's
  // "just like tasks" edit path. No token leaves values alone; `!0` clears
  // the priority, `#0` the project. An unmatched tag creates its project
  // through App's path so the label renders immediately. Mirrors
  // App.handleCommitEdit's patch logic.
  const handleCatchTokens = useCallback(async (
    id: string,
    parsed: { priority: 0 | 1 | 2 | 3 | null; tag: string | null; clearProject: boolean },
  ) => {
    const tier = parsed.priority === null ? null : parsed.priority === 0 ? null : parsed.priority;
    let projectId: string | null | undefined; // undefined = leave alone
    if (parsed.clearProject) projectId = null;
    else if (parsed.tag) {
      const r = resolveNoteTag(parsed.tag, projects);
      projectId = r.projectId ?? (await onCreateProject(r.createProjectName!)).id;
    }
    setNotes((s) =>
      sortNotes(s.map((n) => {
        if (n.id !== id) return n;
        const patch: Partial<Note> = {};
        if (parsed.priority !== null) patch.priority = tier;
        if (projectId !== undefined) patch.projectId = projectId;
        return { ...n, ...patch };
      })),
    );
    if (parsed.priority !== null) notesApi.setPriority(id, tier);
    if (projectId !== undefined) notesApi.setProject(id, projectId);
  }, [projects, onCreateProject]);

  // Collapse/expand a note card in place. Persisted so a relaunch keeps the
  // list as compact as the user left it.
  const toggleCollapse = (id: string) => {
    const next = new Set(collapsedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setCollapsedIds(next);
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
  };

  // What the user sees: notes narrowed by the ⌘P hidden priority tiers, the ⌘F
  // project filter, and/or Focus Mode — the same lens pipeline the task
  // sections use. The render below groups it by tier (P1 → P3 → unmarked).
  const displayNotes = useMemo(
    () =>
      notes.filter(
        (n) =>
          (n.priority === null || !hiddenPriorities.includes(n.priority)) &&
          (projectFilter === null || n.projectId === projectFilter) &&
          (!focusMode || n.priority === 1),
      ),
    [notes, hiddenPriorities, projectFilter, focusMode],
  );

  // A notes list whose entries all share one tier (including all-unmarked) is
  // a single group — no dividers, nothing to label.
  const singleTier =
    displayNotes.length > 0 && displayNotes.every((n) => n.priority === displayNotes[0].priority);

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
          would vanish from the view the moment it's created. TokenField
          colors the typed grammar (##j/##q routes, #tag, !N) and carries the
          nj/nq prefill. */}
      {hiddenFilter !== "only" && (
        <div className="capture">
          <TokenField
            kinds={["entry", "project", "priority"]}
            capture="notes"
            route
            multiline
            rows={3}
            value={draft}
            onChange={setDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                const t = draft.trim();
                if (t) {
                  handleCapture(t);
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
          />
        </div>
      )}

      {/* Grouped by tier (P1 → P3 → unmarked) with the Backlog's divider
          treatment: every tier group introduced by a hairline labeled with its
          bars (empty track for the unmarked tail), dividers derived purely
          from the rendered order so a filtered-out tier drops its divider
          too, and a single-tier list renders undivided. */}
      {displayNotes.map((note, idx) => {
        const dividerBefore =
          !singleTier && (idx === 0 || displayNotes[idx - 1].priority !== note.priority);
        return (
          <Fragment key={note.id}>
            {dividerBefore && (
              <div className="tier-divider">
                <PriorityBars priority={note.priority} />
              </div>
            )}
            <NoteInput
              note={note}
              projects={projects}
              hovered={hoveredId === note.id}
              focused={focusedId === note.id}
              collapsed={collapsedIds.has(note.id)}
              findOpen={findId === note.id}
              onToggleCollapse={() => toggleCollapse(note.id)}
              onUpdate={handleUpdate}
              onCatchTokens={handleCatchTokens}
              onDelete={() => handleDelete(note.id)}
              onHide={(duration) => handleHide(note.id, duration)}
              onUnhide={() => handleUnhide(note.id)}
              onFindClose={() => setFindId(null)}
            />
          </Fragment>
        );
      })}
    </section>
  );
}

// ---- Single note textarea ------------------------------------------------

function NoteInput({
  note, projects, hovered, focused, collapsed, findOpen, onToggleCollapse, onUpdate, onCatchTokens, onDelete, onHide, onUnhide, onFindClose,
}: {
  note: Note;
  projects: Project[];
  hovered: boolean;
  focused: boolean;
  collapsed: boolean;
  /** ⌘F while this note was being editing opened its local find bar. */
  findOpen: boolean;
  onToggleCollapse: () => void;
  onUpdate: (id: string, body: string) => void;
  /** Applies a caught trailing token line to the columns (see Notes). */
  onCatchTokens: (id: string, parsed: { priority: 0 | 1 | 2 | 3 | null; tag: string | null; clearProject: boolean }) => void;
  onDelete: () => void;
  onHide: (duration: HideDuration) => void;
  onUnhide: () => void;
  onFindClose: () => void;
}) {
  const [val, setVal] = useState(note.body);
  const ref = useRef<HTMLTextAreaElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestBody = useRef(note.body);
  // The note's project, resolved against App's list (the single source, like
  // Goals). The collapsed card's label renders from it; a link to a project
  // not in the list (deleted moments ago) just shows no label.
  const project = projects.find((p) => p.id === note.projectId) ?? null;

  // ---- Find in this note (⌘F while editing it) ------------------------------
  // The query and match index live here, not in Notes, because the matches are
  // computed against the live prose (`val`) — only this component holds
  // the text as typed (the parent lags by the debounce). Metadata tokens are
  // not the note's content and don't take part in the find. While the bar is
  // open its input owns focus; matches paint through a transparent-text mirror
  // under the textarea (a textarea can't tint ranges itself).

  const [findQuery, setFindQuery] = useState("");
  const [findIdx, setFindIdx] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);

  // Case-insensitive substring matches as [start, end) offsets into val. The
  // tokens, if a line of them is still pending, are visible on screen and so
  // take part — they're flushed at blur.
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

  // Blur is the "caught" boundary: a trailing token line (blank line + only
  // `!N`/`#tag` tokens) is stripped from the body and applied to the columns —
  // the tokens vanish into the note's tier/label, exactly the way task
  // capture eats them. A last line that isn't pure tokens is just prose and
  // stays. Flushes the debounced save either way. Returns the body that
  // should be on screen afterwards.
  const flushAndCatch = (): string => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const s = splitNoteFooter(val);
    if (s.priority !== null || s.tag !== null || s.clearProject) {
      setVal(s.body);
      onUpdate(note.id, s.body);
      onCatchTokens(note.id, { priority: s.priority, tag: s.tag, clearProject: s.clearProject });
      return s.body;
    }
    onUpdate(note.id, val);
    return val;
  };

  // Export the note as a .txt through the native save panel. The name seeds
  // from the first non-empty prose line — the same line the collapsed preview
  // shows — so the file is recognizable in Finder without opening it. The
  // file carries the prose only; tokens never reach it.
  const handleDownload = async () => {
    // Flush any debounced edit first: the file should match what's on screen.
    const full = flushAndCatch();
    try {
      await notesApi.saveAs(exportName(full), splitNoteFooter(full).body);
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

  // The mirror's children: the text split at the boundaries of the pending
  // footer's tokens (colored — the blur-catch's live twin, so the line colors
  // exactly what the catch will strip and apply) and the find matches (tinted
  // marks, while finding). Both layers are just intervals over the same text,
  // so they merge into one split; a mark around a token keeps both — tint
  // behind, accent glyphs on it. With nothing to color the plain text still
  // renders through the mirror — since the transparency flip it IS the
  // visible text layer, so it must always mount with the textarea.
  const mirrorNodes = useMemo(() => {
    const tokens = scanNoteFooterTokens(val);
    const finds = findOpen ? matches : [];
    // A trailing newline collapses at the mirror's block end (the textarea
    // still reserves the line); a zero-width tail makes the mirror take it.
    const tail = val.endsWith("\n") ? "\u200b" : "";
    if (tokens.length === 0 && finds.length === 0) return val + tail;
    const bounds = new Set<number>([0, val.length]);
    for (const t of tokens) {
      bounds.add(t.start);
      bounds.add(t.end);
    }
    for (const [s, e] of finds) {
      bounds.add(s);
      bounds.add(e);
    }
    const pts = [...bounds].sort((a, b) => a - b);
    const parts: ReactNode[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const s = pts[i];
      const e = pts[i + 1];
      if (e <= s) continue;
      const text = val.slice(s, e);
      const tok = tokens.find((t) => t.start <= s && e <= t.end);
      const mi = finds.findIndex(([ms, me]) => ms <= s && e <= me);
      // A priority token renders as the bars it applies — width-fitted to the
      // raw word (baseTextWidth), because this mirror keeps the native caret
      // and the substitution must not change the line's metrics. #tag has no
      // display form and colors verbatim.
      const inner = tok ? (
        tok.kind === "priority" ? (
          <span key={i} className="tok tok-fitted" style={{ width: baseTextWidth(text) }}>
            <PriorityBars priority={tok.value === "!0" ? null : (Number(tok.value.slice(1)) as 1 | 2 | 3)} />
          </span>
        ) : (
          <span key={i} className="tok">{text}</span>
        )
      ) : text;
      parts.push(
        mi === -1
          ? inner
          : <mark key={i} className={mi === cur ? "note-find-cur" : undefined}>{inner}</mark>,
      );
    }
    parts.push(tail);
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
          {/* The first non-empty PROSE line — a pending token line never
              previews. The project label is the collapsed card's one piece of
              chrome, the row language: same hue-per-project as item rows,
              right-aligned; the preview yields the hover-action cluster its
              corner while revealed (CSS on .note-preview). */}
          <span className="note-preview-text">
            {splitNoteFooter(val).body
              .split("\n")
              .find((l) => l.trim().length > 0)
              ?.trim() ?? ""}
          </span>
          {project && (
            <span className="project-label" style={{ color: projectColor(project.id) }}>
              {project.name}
            </span>
          )}
        </div>
      ) : (
        <div className="note-body-wrap">
          {/* The visible text layer: a copy of the text laid out exactly under
              the textarea (same font/wrap — see .note-mirror in index.css)
              carrying the find marks and the pending footer's colored tokens;
              the textarea above paints its own glyphs transparent, so this
              always mounts — no mirror, no visible text.
              pointer-events: none in CSS, so it never intercepts the editor. */}
          <div className="note-mirror" aria-hidden="true">{mirrorNodes}</div>
          <textarea
            ref={ref}
            className="note-textarea"
            value={val}
            onChange={(e) => {
              setVal(e.target.value);
              autosize();
              scheduleSave(e.target.value);
            }}
            onBlur={flushAndCatch}
            // Esc ladder: find bar → editing → focused. Blur flushes the
            // debounced save (and catches a trailing token line — see
            // flushAndCatch); the note keeps its focus highlight (App's
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
        >{collapsed ? <FindChevron size={12} /> : <FindChevron up size={12} />}</button>
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

// A filesystem-safe .txt name from the note's first non-empty prose line — the
// same line the collapsed preview shows, so an export names itself the way the
// note reads in the list. The metadata footer never names the file. Empty
// notes fall back to "note".
const exportName = (body: string) => {
  const first = splitNoteFooter(body).body.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
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
// a size down for the smaller buttons. Also the collapse/expand button's glyph
// (slot 1): one consistent stroked shape, flipped by the `up` prop — unicode
// ⌃/⌄ are two different glyphs riding the font baseline, so they never
// matched each other or centered in the button.
function FindChevron({ up, size = 11 }: { up?: boolean; size?: number }) {
  return (
    <svg className="action-chevron" viewBox="0 0 12 12" width={size} height={size} aria-hidden="true">
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

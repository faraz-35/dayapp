// Journal — the written journal's own view. Analytics owns the aggregates
// over `actions`; this page owns the prose captured through the notes bus's
// `##j` token (plus its own capture line, which defaults to a journal entry).
// Days render newest-first with their entries in capture order underneath.
// Quotes are NOT shown here — the ⌘P quote modal is their one surface, and
// for now they have no management surface at all (the notes bar's ##q is the
// natural way in; this view's capture still routes a ##q line too).
//
// Self-contained like Notes/Goals: own state, own API, re-fetches on mount
// (every view switch remounts it) and on reloadEpoch (demo-mode swaps).
// Mouse-first like Analytics — free-mode j/k scrolling works globally, but
// the view has no focus-grammar wiring of its own. Rows are the `.item`
// language minus every axis an entry doesn't have: no grip, no checkbox, no
// bars — single-click edits inline (the shared EditInput), hover reveals ×.

import { useEffect, useMemo, useState } from "react";
import { entriesApi, parseEntryCapture, type Entry, type EntryKind } from "./lib";
import { log } from "./log";
import TokenField from "./TokenField";
import { EditInput } from "./components/ItemRow";

// The display order, mirroring list_entries' ORDER BY (journal.rs): newest day
// first, and within a day oldest → newest (ULID text order breaks same-second
// ties). Optimistic adds re-apply it so the list is always what the next
// fetch returns — the sortNotes lesson.
const sortEntries = (list: Entry[]) =>
  [...list].sort(
    (a, b) =>
      b.day.localeCompare(a.day) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );

const dayLabel = (day: string, today: string) =>
  day === today
    ? "Today"
    : new Date(day + "T00:00:00").toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      });

export default function Journal({
  reloadEpoch = 0,
  onQuotesChanged,
}: {
  reloadEpoch?: number;
  /** Bumped up to App when a ##q capture routes from this view's capture
   *  line, so the quote modal's pool re-fetches. */
  onQuotesChanged?: () => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    entriesApi.list()
      .then((list) => setEntries(sortEntries(list)))
      .catch((e) => log.error("journal load failed", e));
  }, [reloadEpoch]);

  // Journal entries grouped by day in display order (the sort above already
  // sequences them; this just draws the group boundaries). Quotes are filtered
  // out — they render only in the rotating line, never here.
  const days = useMemo(() => {
    const out: { day: string; entries: Entry[] }[] = [];
    for (const e of entries) {
      if (e.kind !== "journal") continue;
      const last = out[out.length - 1];
      if (last && last.day === e.day) last.entries.push(e);
      else out.push({ day: e.day, entries: [e] });
    }
    return out;
  }, [entries]);

  const today = new Date().toLocaleDateString("en-CA"); // local ISO date

  // The capture line is the bus with a default: plain text becomes a journal
  // entry (this view's context), a leading ##q still routes to quotes.
  const handleCapture = (raw: string) => {
    const route = parseEntryCapture(raw) ?? { kind: "journal" as EntryKind, text: raw };
    if (!route.text) return;
    entriesApi
      .add(route.kind, route.text)
      .then((e) => {
        setEntries((s) => sortEntries([...s, e]));
        if (route.kind === "quote") onQuotesChanged?.();
      })
      .catch((e) => log.error("entry capture failed", e));
  };

  // Empty commit is a no-op (a blur-cleared line never deletes content — × is
  // the explicit path). Edits never move the day.
  const handleCommit = (entry: Entry, text: string) => {
    setEditingId(null);
    const t = text.trim();
    if (!t || t === entry.text) return;
    setEntries((s) => sortEntries(s.map((e) => (e.id === entry.id ? { ...e, text: t } : e))));
    entriesApi.update(entry.id, t).catch((e) => log.error("entry edit failed", e));
  };

  const handleDelete = (entry: Entry) => {
    setEntries((s) => s.filter((e) => e.id !== entry.id));
    entriesApi.delete(entry.id).catch((e) => log.error("entry delete failed", e));
  };

  const renderRow = (entry: Entry) => (
    <div className="journal-row" key={entry.id} onClick={() => setEditingId(entry.id)}>
      {editingId === entry.id ? (
        <EditInput initial={entry.text} onCommit={(text) => handleCommit(entry, text)} />
      ) : (
        <span className="journal-text">{entry.text}</span>
      )}
      <button
        className="item-action danger"
        title="Delete"
        aria-label="Delete entry"
        onClick={(e) => {
          e.stopPropagation();
          handleDelete(entry);
        }}
      >×</button>
    </div>
  );

  return (
    <section className="journal">
      <div className="section-head">
        <span className="section-name">Journal</span>
      </div>

      {/* The bus's home capture: plain lines land as today's entries. The
          input itself is the affordance — no placeholder, the section
          language. Only the ##q route colors here: past it (and everywhere
          else) this line is verbatim prose — nothing else processes, so
          nothing else colors. */}
      <div className="capture">
        <TokenField
          kinds={["entry"]}
          value={draft}
          onChange={setDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const t = draft.trim();
              if (t) {
                handleCapture(t);
                setDraft("");
              }
            }
            if (e.key === "Escape") {
              if (draft) setDraft("");
              else e.currentTarget.blur();
            }
          }}
        />
      </div>

      {days.length === 0 && (
        <div className="journal-empty">
          No entries yet — write above, or type <code>##j</code> in Notes from the list view.
        </div>
      )}
      {days.map((d) => (
        <div key={d.day}>
          <div className="journal-day">{dayLabel(d.day, today)}</div>
          {d.entries.map(renderRow)}
        </div>
      ))}
    </section>
  );
}

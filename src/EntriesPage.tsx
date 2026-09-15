// EntriesPage — the two written-word pages over the `entries` table, one per
// kind: Journal (##j reflections) and Quotes (##q captures). Same page both
// times: days newest-first under uppercase day headers, entries in capture
// order, single-click to edit inline, hover reveals ×. The capture line is
// the bus with a default — plain text lands as this page's kind, and the
// opposite token still routes (##q from the Journal page, ##j from Quotes).
// The quote modal (Quotes.tsx) stays the summoned moment; these pages are
// the archive — the browsing and editing surface, and the pool's source of
// truth: every quote mutation here re-fetches the modal's pool.
//
// Self-contained like Notes/Goals: own state, own API, re-fetches on mount
// (every view switch remounts it) and on reloadEpoch (demo-mode swaps).
// Mouse-first like Analytics — free-mode j/k scrolling works globally, but
// the view has no focus-grammar wiring of its own. Rows are the `.item`
// language minus every axis an entry doesn't have: no grip, no checkbox, no
// bars.

import { useEffect, useMemo, useState } from "react";
import { entriesApi, parseEntryCapture, todayStr, type Entry, type EntryKind } from "./lib";
import { log } from "./log";
import { clip, trace } from "./devlog";
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

export default function EntriesPage({
  kind,
  reloadEpoch = 0,
  onQuotesChanged,
}: {
  /** Which of the two pages this is — the kind shown and the capture default. */
  kind: EntryKind;
  reloadEpoch?: number;
  /** Bumped up to App when a quote changes from this page — a capture routed
   *  here, an edit, or a delete — so the quote modal's pool re-fetches and
   *  the screensaver never picks a stale line. */
  onQuotesChanged?: () => void;
}) {
  const title = kind === "journal" ? "Journal" : "Quotes";
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    entriesApi.list()
      .then((list) => setEntries(sortEntries(list)))
      .catch((e) => log.error("entries load failed", e));
  }, [reloadEpoch]);

  // This page's entries grouped by day in display order (the sort above
  // already sequences them; this just draws the group boundaries). The other
  // kind is filtered out — it renders on its own page.
  const days = useMemo(() => {
    const out: { day: string; entries: Entry[] }[] = [];
    for (const e of entries) {
      if (e.kind !== kind) continue;
      const last = out[out.length - 1];
      if (last && last.day === e.day) last.entries.push(e);
      else out.push({ day: e.day, entries: [e] });
    }
    return out;
  }, [entries, kind]);

  const today = todayStr(); // the app's day (6am→6am)

  // The capture line is the bus with a default: plain text becomes this
  // page's kind, a leading token of either family still routes.
  const handleCapture = (raw: string) => {
    const route = parseEntryCapture(raw) ?? { kind, text: raw };
    if (!route.text) return;
    trace("capture.entry", { kind: route.kind, text: clip(route.text), via: title.toLowerCase() });
    entriesApi
      .add(route.kind, route.text)
      .then((e) => {
        setEntries((s) => sortEntries([...s, e]));
        if (route.kind === "quote") onQuotesChanged?.();
      })
      .catch((e) => log.error("entry capture failed", e));
  };

  // Empty commit is a no-op (a blur-cleared line never deletes content — × is
  // the explicit path). Edits never move the day. A quote edit re-fetches the
  // modal's pool — this page is the archive, the modal follows it.
  const handleCommit = (entry: Entry, text: string) => {
    setEditingId(null);
    const t = text.trim();
    if (!t || t === entry.text) return;
    setEntries((s) => sortEntries(s.map((e) => (e.id === entry.id ? { ...e, text: t } : e))));
    entriesApi.update(entry.id, t).catch((e) => log.error("entry edit failed", e));
    if (entry.kind === "quote") onQuotesChanged?.();
  };

  const handleDelete = (entry: Entry) => {
    trace("entry.delete", { text: clip(entry.text) });
    setEntries((s) => s.filter((e) => e.id !== entry.id));
    entriesApi.delete(entry.id).catch((e) => log.error("entry delete failed", e));
    if (entry.kind === "quote") onQuotesChanged?.();
  };

  const renderRow = (entry: Entry) => (
    <div
      className="entry-row"
      key={entry.id}
      onClick={() => {
        if (editingId !== entry.id) {
          trace("edit.start", { via: "click", subject: "entry" });
          setEditingId(entry.id);
        }
      }}
    >
      {editingId === entry.id ? (
        <EditInput initial={entry.text} onCommit={(text) => handleCommit(entry, text)} />
      ) : (
        <span className="entry-text">{entry.text}</span>
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
    <section className="entry-page">
      <div className="section-head">
        <span className="section-name">{title}</span>
      </div>

      {/* The bus's home capture: plain lines land as this page's kind. The
          input itself is the affordance — no placeholder, the section
          language. Only the ##j/##q routes color here: past them (and
          everywhere else) this line is verbatim prose — nothing else
          processes, so nothing else colors. */}
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
        <div className="entry-empty">
          No {kind === "journal" ? "entries" : "quotes"} yet — write above, or type{" "}
          <code>##{kind === "journal" ? "j" : "q"}</code> in Notes from the list view.
        </div>
      )}
      {days.map((d) => (
        <div key={d.day}>
          <div className="entry-day">{dayLabel(d.day, today)}</div>
          {d.entries.map(renderRow)}
        </div>
      ))}
    </section>
  );
}

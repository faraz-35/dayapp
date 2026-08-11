// JournalView — reads the append-only `actions` log and groups by day. This is
// the auto-journal: every create/complete/move/edit/delete/sweep writes a row,
// so the view composes itself.

import { useEffect, useMemo, useState } from "react";
import { api, localDateStr, localDateStrOffset, type Action } from "../lib";

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

export default function JournalView() {
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
    <div className="journal-view">
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

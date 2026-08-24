// JournalView — reads the append-only `actions` log and groups by day. This is
// the auto-journal: every create/complete/move/edit/delete/sweep writes a row,
// so the view composes itself. Time tracked on each task is layered in as a
// per-day total (in the day header) and a per-task breakdown block — sessions
// are a separate dimension (see src-tauri/src/timers.rs), not action rows.
// The dashboard block above the day groups (JournalDashboard) summarizes the
// same log: done/missed per range, heatmap, project/priority splits.

import { useEffect, useMemo, useState } from "react";
import JournalDashboard from "./JournalDashboard";
import {
  api,
  formatDuration,
  journalApi,
  localDateStr,
  localDateStrOffset,
  timersApi,
  type Action,
  type DashboardStats,
  type DayTaskTime,
} from "../lib";
import { log } from "../log";

const VERB: Record<string, string> = {
  created: "added",
  completed: "completed",
  uncompleted: "unchecked",
  moved: "moved",
  edited: "edited",
  deleted: "deleted",
  fell_to_backlog: "fell to backlog",
  goal_created: "set goal",
  goal_achieved: "achieved goal",
  goal_unachieved: "reopened goal",
  goal_edited: "edited goal",
  goal_deleted: "dropped goal",
};

type JournalRange = "today" | "week" | "month" | "all";

export default function JournalView() {
  const [actions, setActions] = useState<Action[]>([]);
  const [times, setTimes] = useState<DayTaskTime[]>([]);
  const [dash, setDash] = useState<DashboardStats | null>(null);
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
    timersApi.sessionTimeByDay({ since: bounds.since, until: bounds.until })
      .then(setTimes)
      .catch((e) => log.warn("session time load failed", e));
    journalApi.dashboard({ since: bounds.since, until: bounds.until })
      .then(setDash)
      .catch((e) => log.warn("dashboard load failed", e));
  }, [bounds]);

  // The dashboard's per-day rows, keyed by date — the day headers' done/missed.
  const dashDays = useMemo(
    () => new Map((dash?.days ?? []).map((d) => [d.date, d])),
    [dash],
  );

  const filtered = useMemo(() => {
    if (filter === "all") return actions;
    // "Goals" spans the five goal_* verbs — one pill for the whole
    // identity-layer narrative.
    if (filter === "goal") return actions.filter((a) => a.action.startsWith("goal_"));
    return actions.filter((a) => a.action === filter);
  }, [actions, filter]);

  // Actions grouped by day. Time is a separate dimension (not affected by the
  // action-type filter), so it has its own map.
  const actionsByDay = useMemo(() => {
    const map = new Map<string, Action[]>();
    for (const a of filtered) {
      const day = a.timestamp.slice(0, 10);
      if (!map.has(day)) map.set(day, []);
      map.get(day)!.push(a);
    }
    return map;
  }, [filtered]);

  // Per-task time grouped by day, each day's tasks sorted longest-first.
  const timeByDay = useMemo(() => {
    const map = new Map<string, DayTaskTime[]>();
    for (const t of times) {
      if (!map.has(t.day)) map.set(t.day, []);
      map.get(t.day)!.push(t);
    }
    for (const arr of map.values()) arr.sort((a, b) => b.seconds - a.seconds);
    return map;
  }, [times]);

  // The set of days to render is the union of days with actions (post-filter)
  // and days with tracked time — so a day with only time still shows up.
  const days = useMemo(() => {
    const set = new Set<string>();
    for (const a of filtered) set.add(a.timestamp.slice(0, 10));
    for (const t of times) set.add(t.day);
    return Array.from(set).sort().reverse();
  }, [filtered, times]);

  const dayTotal = (day: string) =>
    (timeByDay.get(day) ?? []).reduce((s, t) => s + t.seconds, 0);

  const filters = [
    { id: "all", label: "All" },
    { id: "completed", label: "Done" },
    { id: "created", label: "Added" },
    { id: "moved", label: "Moved" },
    { id: "fell_to_backlog", label: "Fell" },
    { id: "deleted", label: "Deleted" },
    { id: "goal", label: "Goals" },
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
        {dash && (
          <JournalDashboard
            stats={dash}
            activeDay={dayPick}
            // Clicking the picked cell again clears the pick, like a toggle.
            onPickDay={(d) => setDayPick((cur) => (cur === d ? null : d))}
          />
        )}
        {days.length === 0 && <div className="journal-empty">No activity yet.</div>}
        {days.map((day) => {
          const total = dayTotal(day);
          const ds = dashDays.get(day);
          const missed = ds ? ds.dailyMissed + ds.todayMissed : 0;
          return (
            <div key={day}>
              <div className="journal-day">
                {day}
                {ds != null && ds.done > 0 && (
                  <span className="journal-day-stats"> · {ds.done} done</span>
                )}
                {missed > 0 && (
                  <span className="journal-day-stats"> · {missed} missed</span>
                )}
                {total > 0 && <span className="journal-day-time"> · {formatDuration(total)}</span>}
              </div>
              {/* Time-by-task breakdown — only tasks with tracked time that day. */}
              {timeByDay.get(day)?.map((t) => (
                <div key={`t-${t.day}-${t.itemId}`} className="journal-time-row">
                  <span className="journal-time-icon">⏱</span>
                  <span className="journal-time-text">{t.itemText || "(deleted)"}</span>
                  <span className="journal-time-secs">{formatDuration(t.seconds)}</span>
                </div>
              ))}
              {actionsByDay.get(day)?.map((a) => (
                <div key={a.id} className="journal-row">
                  <span className="journal-time">{a.timestamp.slice(11, 16)}</span>
                  <span className="journal-verb">{VERB[a.action] ?? a.action}</span>
                  <span className="journal-text">{a.itemText}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

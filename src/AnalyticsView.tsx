// AnalyticsView — the analytics page (top-right ≡). Synthesis over the
// append-only `actions` log, never the log itself: range-scoped stats
// (done, avg/day, streak, daily missed, today missed), a ~7-month completion
// heatmap, project + priority splits, and a one-line-per-day ledger of
// counts. The raw action log's textual home is the CLI's --journal — the GUI
// answers questions, it doesn't enumerate events. Clicking a heatmap cell or
// a day row scopes everything to that day (click it again to clear). All
// derivation lives in src-tauri/src/dashboard.rs; per-day time totals are
// layered in from sessions like everywhere else.

import { useEffect, useMemo, useState } from "react";
import { PriorityBars } from "./components/ItemRow";
import {
  formatDuration,
  formatReminder,
  journalApi,
  localDateStr,
  localDateStrOffset,
  timersApi,
  type DashboardStats,
  type DayTaskTime,
} from "./lib";
import { log } from "./log";

type Range = "today" | "week" | "month" | "all";

/** Week columns rendered (Monday-aligned, oldest left). 30 keeps the grid
 *  inside the 480px window with room for the weekday label gutter. */
const WEEKS = 30;
const DAY_MS = 86_400_000;

const level = (done: number): number =>
  done === 0 ? 0 : done >= 7 ? 4 : done >= 4 ? 3 : done >= 2 ? 2 : 1;

type Cell = { date: string; done: number; future: boolean; isToday: boolean };

/** Week columns of cells, oldest week first, Monday at the top. The grid
 *  starts on the Monday on/before (today − (WEEKS−1) weeks) so the final
 *  column is the current week. */
function heatmapColumns(map: Map<string, number>): Cell[][] {
  const today = localDateStr();
  const todayMs = new Date(today + "T00:00:00").getTime();
  const mondayOffset = (new Date(today + "T00:00:00").getDay() + 6) % 7;
  const firstMonday = todayMs - (mondayOffset + (WEEKS - 1) * 7) * DAY_MS;
  const cols: Cell[][] = [];
  for (let w = 0; w < WEEKS; w++) {
    const col: Cell[] = [];
    for (let d = 0; d < 7; d++) {
      const date = localDateStr(new Date(firstMonday + (w * 7 + d) * DAY_MS));
      col.push({
        date,
        done: map.get(date) ?? 0,
        future: date > today,
        isToday: date === today,
      });
    }
    cols.push(col);
  }
  return cols;
}

function Stat({ value, label, accent }: { value: string | number; label: string; accent?: boolean }) {
  return (
    <div className={`dash-stat${accent ? " accent" : ""}`}>
      <span className="dash-value">{value}</span>
      <span className="dash-label">{label}</span>
    </div>
  );
}

/** One label/bar/count row — the shared shape of the project and priority
 *  splits. The bar's width is relative to `max`, so the group reads as
 *  proportions at a glance. */
function SplitRow({
  label,
  title,
  count,
  max,
  glyph,
}: {
  label: React.ReactNode;
  title?: string;
  count: number;
  max: number;
  glyph?: boolean;
}) {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  return (
    <div className={`dash-row${count === 0 ? " zero" : ""}`} title={title}>
      <span className={`dash-row-label${glyph ? " glyph" : ""}`}>{label}</span>
      <span className="dash-row-bar">
        <span className="dash-row-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="dash-row-count">{count}</span>
    </div>
  );
}

export default function AnalyticsView() {
  const [dash, setDash] = useState<DashboardStats | null>(null);
  const [times, setTimes] = useState<DayTaskTime[]>([]);
  const [range, setRange] = useState<Range>("week");
  // When set, overrides the range pills with a single specific day (picked
  // on the heatmap or a ledger row).
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
    journalApi.dashboard({ since: bounds.since, until: bounds.until })
      .then(setDash)
      .catch((e) => log.warn("dashboard load failed", e));
    timersApi.sessionTimeByDay({ since: bounds.since, until: bounds.until })
      .then(setTimes)
      .catch((e) => log.warn("session time load failed", e));
  }, [bounds]);

  // Per-day tracked-time totals (sessions are a separate dimension; the
  // ledger shows the sum only).
  const timeByDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of times) map.set(t.day, (map.get(t.day) ?? 0) + t.seconds);
    return map;
  }, [times]);

  const pickDay = (d: string) => setDayPick((cur) => (cur === d ? null : d));

  const ranges: { id: Range; label: string }[] = [
    { id: "today", label: "Today" },
    { id: "week", label: "Week" },
    { id: "month", label: "Month" },
    { id: "all", label: "All" },
  ];

  const heat = useMemo(() => new Map((dash?.heatmap ?? []).map((h) => [h.date, h.done])), [dash]);
  const cols = useMemo(() => heatmapColumns(heat), [heat]);
  const maxProject = Math.max(1, ...(dash?.projects ?? []).map((p) => p.count));
  const maxTier = Math.max(1, ...(dash?.priorities ?? []).map((t) => t.count));

  // The ledger: one line per day that had any signal, newest first.
  const ledger = useMemo(() => {
    if (!dash) return [];
    return dash.days
      .filter(
        (d) =>
          d.done > 0 ||
          d.dailyMissed + d.todayMissed > 0 ||
          (timeByDay.get(d.date) ?? 0) > 0,
      )
      .reverse();
  }, [dash, timeByDay]);

  const today = localDateStr();
  const dayCount = dash?.days.length ?? 0;
  const avg =
    dash && dayCount > 1 ? (dash.totals.done / dayCount).toFixed(1) : null;

  return (
    <div className="analytics-view">
      {/* Range segments · date jump. Picking a date (or a heatmap cell / ledger
          row) overrides the pills until a pill is clicked. */}
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
          value={dayPick ?? today}
          onChange={(e) => setDayPick(e.target.value || null)}
          title="Jump to a specific day"
        />
      </div>
      <div className="analytics">
        {dash && (
          <>
            <div className="dash-stats">
              <Stat value={dash.totals.done} label="Done" accent />
              {avg != null && <Stat value={avg} label="Avg / day" />}
              <Stat value={dash.totals.streak} label="Streak" />
              <Stat value={dash.totals.dailyMissed} label="Daily missed" />
              <Stat value={dash.totals.todayMissed} label="Today missed" />
            </div>

            <div className="hm">
              <div className="hm-months">
                {cols.map((col, w) => {
                  const month = col[0].date.slice(5, 7);
                  const prev = w > 0 ? cols[w - 1][0].date.slice(5, 7) : null;
                  if (month === prev) return null;
                  return (
                    <span key={w} style={{ gridColumn: w + 1 }}>
                      {new Date(col[0].date + "T00:00:00").toLocaleDateString(undefined, {
                        month: "short",
                      })}
                    </span>
                  );
                })}
              </div>
              <div className="hm-body">
                <div className="hm-days">
                  {["M", "", "W", "", "F", "", ""].map((l, i) => (
                    <span key={i}>{l}</span>
                  ))}
                </div>
                <div className="hm-grid">
                  {cols.flat().map((c) => {
                    const cls = [
                      "hm-cell",
                      level(c.done) > 0 ? `l${level(c.done)}` : "",
                      c.future ? "future" : "",
                      c.isToday ? "today" : "",
                      dayPick === c.date ? "picked" : "",
                    ]
                      .filter(Boolean)
                      .join(" ");
                    return (
                      <button
                        key={c.date}
                        className={cls}
                        disabled={c.future}
                        title={c.future ? undefined : `${formatReminder(c.date)}${c.done ? ` · ${c.done} done` : ""}`}
                        onClick={() => pickDay(c.date)}
                      />
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="dash-cols">
              {dash.projects.length > 0 && (
                <div className="dash-block">
                  <div className="dash-h">Projects</div>
                  {dash.projects.map((p) => (
                    <SplitRow
                      key={p.name ?? "__none"}
                      label={p.name ?? "none"}
                      title={p.name ? `#${p.name}` : "no project"}
                      count={p.count}
                      max={maxProject}
                    />
                  ))}
                </div>
              )}
              <div className="dash-block">
                <div className="dash-h">Priority</div>
                {dash.priorities.map((t) => (
                  <SplitRow
                    key={t.tier ?? 0}
                    label={<PriorityBars priority={t.tier} />}
                    title={t.tier == null ? "unmarked" : `Priority ${t.tier}`}
                    count={t.count}
                    max={maxTier}
                    glyph
                  />
                ))}
              </div>
            </div>

            <div className="dash-block">
              <div className="dash-h">Days</div>
              {ledger.length === 0 && (
                <div className="dash-empty">No activity in this range.</div>
              )}
              {ledger.map((d) => {
                const secs = timeByDay.get(d.date) ?? 0;
                const missed = d.dailyMissed + d.todayMissed;
                return (
                  <button
                    key={d.date}
                    className={`dash-day${dayPick === d.date ? " picked" : ""}`}
                    onClick={() => pickDay(d.date)}
                    title={dayPick === d.date ? "Click again to clear the pick" : "Scope the page to this day"}
                  >
                    <span className="dash-day-date">
                      {d.date === today
                        ? "Today"
                        : new Date(d.date + "T00:00:00").toLocaleDateString(undefined, {
                            weekday: "short",
                            month: "short",
                            day: "numeric",
                          })}
                    </span>
                    <span className="dash-day-stats">
                      {d.done > 0 && <span>{d.done} done</span>}
                      {missed > 0 && <span>{missed} missed</span>}
                      {secs > 0 && <span className="time">{formatDuration(secs)}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

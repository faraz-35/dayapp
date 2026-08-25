// AnalyticsView — the analytics page (top-right ≡): a dashboard of elevated
// cards synthesized over the append-only `actions` log, never the log itself.
// A hero stats card, the current month as a calendar heatmap (intensity =
// completions; click a day to open it), the distribution cards (project bars
// + a segmented priority bar), and the day ledger whose rows expand to that
// day's tasks (done with times, what fell, missed habits — the raw action
// log's textual home remains the CLI's --journal). Clicking a calendar cell,
// a ledger row, or the date field picks a day; click it again to clear.
// Responsive: cards stack on the 480px window; a wide window spans the hero
// across the top, sets Activity/Projects/Priority in one row, and gives the
// ledger its own full-width row. All derivation lives in
// src-tauri/src/dashboard.rs; per-task time is layered in from sessions.

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
  type DayDetail,
  type DayTaskTime,
  type TierCount,
} from "./lib";
import { log } from "./log";

type Range = "today" | "week" | "month" | "all";

const level = (done: number): number =>
  done === 0 ? 0 : done >= 7 ? 4 : done >= 4 ? 3 : done >= 2 ? 2 : 1;

/** The level colors as a shared scale — the calendar cells and its legend. */
const LEVEL_BG = [
  "var(--bg-hover)",
  "rgba(123, 140, 255, 0.28)",
  "rgba(123, 140, 255, 0.5)",
  "rgba(123, 140, 255, 0.75)",
  "var(--accent)",
];

/** Priority's segment colors — intensity steps of the one accent, the same
 *  scale language as the calendar (P1 carries the most weight). */
const TIER_BG: Record<string, string> = {
  "1": "var(--accent)",
  "2": "rgba(123, 140, 255, 0.62)",
  "3": "rgba(123, 140, 255, 0.36)",
  none: "rgba(123, 140, 255, 0.16)",
};

type Cell = {
  date: string;
  day: number;
  done: number;
  future: boolean;
  isToday: boolean;
};

/** The current calendar month as a Monday-first grid: `lead` blanks, then
 *  one cell per day (intensity = that day's completions). Trailing blanks
 *  aren't needed — the CSS grid just ends the last row short. */
function monthCalendar(map: Map<string, number>): (Cell | null)[] {
  const today = localDateStr();
  const t = new Date(today + "T00:00:00");
  const year = t.getFullYear();
  const month = t.getMonth();
  const lead = (new Date(year, month, 1).getDay() + 6) % 7; // days before Monday
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (Cell | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const date = localDateStr(new Date(year, month, d));
    cells.push({
      date,
      day: d,
      done: map.get(date) ?? 0,
      future: date > today,
      isToday: date === today,
    });
  }
  return cells;
}

function Stat({ value, label, accent }: { value: string | number; label: string; accent?: boolean }) {
  return (
    <div className={`an-stat${accent ? " accent" : ""}`}>
      <span className="v">{value}</span>
      <span className="l">{label}</span>
    </div>
  );
}

/** One label/bar/count row of the projects card — the bar is relative to
 *  `max`, so the group reads as proportions at a glance. */
function BarRow({
  label,
  title,
  count,
  max,
}: {
  label: string;
  title?: string;
  count: number;
  max: number;
}) {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  return (
    <div className={`an-row${count === 0 ? " zero" : ""}`} title={title}>
      <span className="name">{label}</span>
      <span className="track">
        <span className="fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="count">{count}</span>
    </div>
  );
}

/** The priority card's shape: one segmented bar (tier proportions) plus a
 *  glyph legend. Says "which tier you usually clear" in one glance. */
function PriorityCard({ tiers, max }: { tiers: TierCount[]; max: number }) {
  const total = tiers.reduce((s, t) => s + t.count, 0);
  return (
    <section className="an-card an-priority">
      <div className="an-card-title">Priority</div>
      <div className="an-segbar">
        {tiers.map((t) => (
          <span
            key={t.tier ?? 0}
            className="seg"
            style={{
              width: total > 0 ? `${(t.count / total) * 100}%` : "0%",
              background: TIER_BG[t.tier == null ? "none" : String(t.tier)],
            }}
          />
        ))}
      </div>
      <div className="an-seg-legend">
        {tiers.map((t) => (
          <span key={t.tier ?? 0} className={`leg${max > 0 && t.count === 0 ? " zero" : ""}`}>
            <PriorityBars priority={t.tier} />
            {t.count}
          </span>
        ))}
      </div>
    </section>
  );
}

/** The expand affordance — one chevron glyph, rotated open (never two
 *  mismatched unicode glyphs riding the font baseline). */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`dd-chev${open ? " open" : ""}`}
      width="10"
      height="10"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path
        d="M4 2.8 8.2 6 4 9.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function AnalyticsView() {
  const [dash, setDash] = useState<DashboardStats | null>(null);
  const [times, setTimes] = useState<DayTaskTime[]>([]);
  const [detail, setDetail] = useState<DayDetail | null>(null);
  const [range, setRange] = useState<Range>("week");
  // The day whose ledger row is expanded (and whose calendar cell is ringed).
  // Picking never re-scopes the stats — the range pills own that.
  const [pickedDay, setPickedDay] = useState<string | null>(null);

  // Resolve the half-open [since, until) window from the active range.
  // `until` is the day *after* the target so a day boundary is inclusive.
  const bounds = useMemo(() => {
    switch (range) {
      case "today": return { since: localDateStr(), until: localDateStrOffset(1) };
      case "week":  return { since: localDateStrOffset(-6), until: localDateStrOffset(1) };
      case "month": return { since: localDateStrOffset(-29), until: localDateStrOffset(1) };
      case "all":   return { since: undefined, until: undefined };
    }
  }, [range]);

  useEffect(() => {
    journalApi.dashboard({ since: bounds.since, until: bounds.until })
      .then(setDash)
      .catch((e) => log.warn("dashboard load failed", e));
    timersApi.sessionTimeByDay({ since: bounds.since, until: bounds.until })
      .then(setTimes)
      .catch((e) => log.warn("session time load failed", e));
  }, [bounds]);

  useEffect(() => {
    setDetail(null);
    if (!pickedDay) return;
    journalApi.dayDetail(pickedDay)
      .then(setDetail)
      .catch((e) => log.warn("day detail load failed", e));
  }, [pickedDay]);

  // Bring the expanded row into view once its data has landed.
  useEffect(() => {
    if (!pickedDay) return;
    document
      .querySelector(`[data-day="${pickedDay}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [pickedDay, dash, detail]);

  // Per-day tracked-time totals (sessions are a separate dimension; the
  // ledger shows the sum only).
  const timeByDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of times) map.set(t.day, (map.get(t.day) ?? 0) + t.seconds);
    return map;
  }, [times]);

  const pickDay = (d: string) => {
    if (d === pickedDay) {
      setPickedDay(null);
      return;
    }
    // A day outside the active range's ledger (calendar cell, date field):
    // widen to All so the expanded row has somewhere to render.
    const { since, until } = bounds;
    if ((since && d < since) || (until && d >= until)) setRange("all");
    setPickedDay(d);
  };

  const ranges: { id: Range; label: string }[] = [
    { id: "today", label: "Today" },
    { id: "week", label: "Week" },
    { id: "month", label: "Month" },
    { id: "all", label: "All" },
  ];

  const heat = useMemo(() => new Map((dash?.heatmap ?? []).map((h) => [h.date, h.done])), [dash]);
  const cells = useMemo(() => monthCalendar(heat), [heat]);
  const monthLabel = new Date(localDateStr() + "T00:00:00").toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
  const maxProject = Math.max(1, ...(dash?.projects ?? []).map((p) => p.count));
  const maxTier = Math.max(1, ...(dash?.priorities ?? []).map((t) => t.count));

  // The ledger: one line per day that had any signal (the picked day stays
  // listed even when empty, so its expansion has a row), newest first.
  const ledger = useMemo(() => {
    if (!dash) return [];
    return dash.days
      .filter((d) => d.date === pickedDay || d.done > 0 || d.dailyMissed + d.todayMissed > 0 ||
        (timeByDay.get(d.date) ?? 0) > 0)
      .reverse();
  }, [dash, timeByDay, pickedDay]);

  const today = localDateStr();
  const dayCount = dash?.days.length ?? 0;
  const avg =
    dash && dayCount > 1 ? (dash.totals.done / dayCount).toFixed(1) : null;

  return (
    <div className="analytics-view">
      {/* Range segments · date jump. The date field (like a calendar cell)
          picks a day to expand in the ledger. */}
      <div className="filter-bar">
        {ranges.map((r) => (
          <button
            key={r.id}
            className={`pill${range === r.id ? " active" : ""}`}
            onClick={() => { setRange(r.id); setPickedDay(null); }}
          >{r.label}</button>
        ))}
        <input
          type="date"
          className={`date-jump${pickedDay ? " active" : ""}`}
          value={pickedDay ?? today}
          onChange={(e) => e.target.value && pickDay(e.target.value)}
          title="Pick a day to see its tasks"
        />
      </div>
      <div className="analytics">
        {dash && (
          <>
            <section className="an-card an-hero">
              <Stat value={dash.totals.done} label="Done" accent />
              {avg != null && <Stat value={avg} label="Avg / day" />}
              <Stat value={dash.totals.streak} label="Day streak" />
              <Stat value={dash.totals.dailyMissed} label="Daily missed" />
              <Stat value={dash.totals.todayMissed} label="Today missed" />
            </section>

            <div className="an-row3">
              <section className="an-card an-activity">
                <div className="an-card-title">
                  Activity
                  <span className="hint">{monthLabel}</span>
                </div>
                <div className="cal">
                  <div className="cal-head">
                    {["M", "T", "W", "T", "F", "S", "S"].map((l, i) => (
                      <span key={i}>{l}</span>
                    ))}
                  </div>
                  <div className="cal-grid">
                    {cells.map((c, i) =>
                      c == null ? (
                        <span key={`b-${i}`} className="cal-cell blank" />
                      ) : (
                        <button
                          key={c.date}
                          className={[
                            "cal-cell",
                            level(c.done) > 0 ? `l${level(c.done)}` : "",
                            c.future ? "future" : "",
                            c.isToday ? "today" : "",
                            pickedDay === c.date ? "picked" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          disabled={c.future}
                          title={`${formatReminder(c.date)}${c.done ? ` · ${c.done} done` : ""}`}
                          onClick={() => pickDay(c.date)}
                        >
                          <span className="n">{c.day}</span>
                          {c.done > 0 && <span className="c">{c.done}</span>}
                        </button>
                      ),
                    )}
                  </div>
                  <div className="hm-legend">
                    Less
                    {[0, 1, 2, 3, 4].map((l) => (
                      <i key={l} style={{ background: LEVEL_BG[l] }} />
                    ))}
                    More
                  </div>
                </div>
              </section>

              {dash.projects.length > 0 && (
                <section className="an-card an-projects">
                  <div className="an-card-title">Projects</div>
                  {dash.projects.map((p) => (
                    <BarRow
                      key={p.name ?? "__none"}
                      label={p.name ?? "none"}
                      title={p.name ? `#${p.name}` : "no project"}
                      count={p.count}
                      max={maxProject}
                    />
                  ))}
                </section>
              )}

              <PriorityCard tiers={dash.priorities} max={maxTier} />
            </div>

            <section className="an-card an-days">
              <div className="an-card-title">Days</div>
              {ledger.length === 0 && (
                <div className="dash-empty">No activity in this range.</div>
              )}
              {ledger.map((d) => {
                const secs = timeByDay.get(d.date) ?? 0;
                const missed = d.dailyMissed + d.todayMissed;
                const open = pickedDay === d.date;
                return (
                  <div key={d.date} className={`an-day-wrap${open ? " open" : ""}`} data-day={d.date}>
                    <button
                      className={`an-day${open ? " picked" : ""}`}
                      onClick={() => pickDay(d.date)}
                      title={open ? "Click again to collapse" : "Show this day's tasks"}
                    >
                      <span className="d">
                        {d.date === today
                          ? "Today"
                          : new Date(d.date + "T00:00:00").toLocaleDateString(undefined, {
                              weekday: "short",
                              month: "short",
                              day: "numeric",
                            })}
                      </span>
                      <span className="s">
                        {d.done > 0 && <span className="done">{d.done} done</span>}
                        {missed > 0 && <span>{missed} missed</span>}
                        {secs > 0 && <span className="time">{formatDuration(secs)}</span>}
                        <Chevron open={open} />
                      </span>
                    </button>
                    {open && (
                      <div className="an-day-detail">
                        {detail == null && <div className="dd-empty">…</div>}
                        {detail?.done.map((t) => (
                          <div key={t.itemId} className="dd-row done">
                            <span className="dd-mark">✓</span>
                            <span className="dd-time">{t.time}</span>
                            <span className="dd-text">{t.text}</span>
                            {t.secs > 0 && (
                              <span className="dd-secs">{formatDuration(t.secs)}</span>
                            )}
                          </div>
                        ))}
                        {detail?.fell.map((f) => (
                          <div key={`f-${f.time}-${f.text}`} className="dd-row fell">
                            <span className="dd-mark">↓</span>
                            <span className="dd-time">{f.time}</span>
                            <span className="dd-text">{f.text}</span>
                            <span className="dd-tag">fell</span>
                          </div>
                        ))}
                        {detail?.dailyMissed.map((m) => (
                          <div key={`m-${m}`} className="dd-row missed">
                            <span className="dd-mark">○</span>
                            <span className="dd-text">{m}</span>
                            <span className="dd-tag">missed</span>
                          </div>
                        ))}
                        {detail != null &&
                          detail.done.length === 0 &&
                          detail.fell.length === 0 &&
                          detail.dailyMissed.length === 0 && (
                            <div className="dd-empty">Nothing that day.</div>
                          )}
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

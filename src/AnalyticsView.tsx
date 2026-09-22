// AnalyticsView — the analytics page (top-right ≡): a dashboard of elevated
// cards synthesized over the append-only `actions` log, never the log itself.
// A toggle at the left of the filter bar picks the subject — done (effective
// completions, with the miss verdicts) or created (the tasks that entered
// the list); every card follows it, and the done-only stats (streak, both
// misses) hide in created mode. A hero stats card, the current month as a
// calendar heatmap (intensity = the subject's per-day count), the
// distribution cards (project bars + a segmented priority bar), and the day
// ledger. Selecting a day — a ledger row, a calendar cell, the date field,
// or the Today pill (which scopes the range to today and opens its card) —
// replaces the ledger with that one day's card: label + counts, a back
// button, and the day at task level (done with times and axes, what fell,
// missed habits — the raw action log's textual home remains the CLI's
// --journal). The calendar card's width is capped at the 480px-window card
// size, so a filtered axis unmounting its split card can't stretch the
// squares across the freed track; the projects card hides zero-count rows
// until its expand chevron reveals the whole roster.
// The filter bar also carries the axis scope filters — a `#` project picker
// (multi-select popover) and priority tier chips — which every derivation
// follows via the backend's write-time snapshots (see dashboard.rs); a split
// card whose axis is filtered hides (a filtered view already answers it),
// and time deliberately doesn't follow (the day card hides its total while
// filtered; per-task time rides the filtered task rows).
// Responsive: cards stack on the 480px window; a wide window spans the hero
// across the top, sets Activity/Projects/Priority in one row, and gives the
// ledger/day card its own full-width row. All derivation lives in
// src-tauri/src/dashboard.rs; per-task time is layered in from sessions.

import { useEffect, useMemo, useRef, useState } from "react";
import { PriorityBars } from "./components/PriorityBars";
import {
  formatDuration,
  formatReminder,
  journalApi,
  localDateStr,
  projectColor,
  projectsApi,
  timersApi,
  todayOffset,
  todayStr,
  type DashboardFilter,
  type DashboardStats,
  type DashboardSubject,
  type DayDetail,
  type DayTaskTime,
  type Project,
  type TierCount,
} from "./lib";
import { log } from "./log";
import { trace } from "./devlog";

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
  count: number;
  future: boolean;
  isToday: boolean;
};

/** The current calendar month as a Monday-first grid: `lead` blanks, then
 *  one cell per day (intensity = that day's count of the active subject).
 *  Anchored on the app's logical today (6am→6am), so a 1am session fills
 *  yesterday's cell. Trailing blanks aren't needed — the CSS grid just ends
 *  the last row short. */
function monthCalendar(map: Map<string, number>): (Cell | null)[] {
  const today = todayStr();
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
      count: map.get(date) ?? 0,
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
 *  mismatched unicode glyphs riding the font baseline). `className` carries
 *  per-surface variants (`.left` = the day card's back arrow). */
function Chevron({ open = false, className = "" }: { open?: boolean; className?: string }) {
  return (
    <svg
      className={`dd-chev${open ? " open" : ""}${className ? ` ${className}` : ""}`}
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
  // What the page counts — the toggle at the left of the filter bar. The
  // picked day survives a switch: the same day re-expands through the other
  // lens.
  const [subject, setSubject] = useState<DashboardSubject>("done");
  // The day whose card is open (and whose calendar cell is ringed). Picking
  // never re-scopes the stats — the range pills own that.
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  // The projects card hides its zero-count rows until this chevron opens them.
  const [showZeroProjects, setShowZeroProjects] = useState(false);

  // ---- Axis scope filters (session-only, like the range) -------------------
  // "" in selProjects = the "no project" bucket; 0 in selTiers = unmarked.
  const [projects, setProjects] = useState<Project[]>([]);
  const [selProjects, setSelProjects] = useState<Set<string>>(new Set());
  const [selTiers, setSelTiers] = useState<Set<number>>(new Set());
  const [projMenu, setProjMenu] = useState(false);
  const projMenuRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    projectsApi.list().then(setProjects).catch((e) => log.warn("projects load failed", e));
  }, []);

  // Outside-click closes the project popover (the ProjectMenu pattern).
  useEffect(() => {
    if (!projMenu) return;
    const onDown = (e: MouseEvent) => {
      if (projMenuRef.current && !projMenuRef.current.contains(e.target as Node)) {
        setProjMenu(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [projMenu]);

  // The picker is keyboard-first like everything else: `#` opens it, arrows +
  // Enter toggle the highlighted project, Esc closes. Capture phase so the
  // global free-mode arrows don't scroll the page underneath the menu.
  const projChoices = [...projects.map((p) => p.name), ""]; // "" = No project, last
  const [projHi, setProjHi] = useState(0);
  useEffect(() => {
    if (projMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "#") return;
      const el = e.target as HTMLElement | null;
      if (el?.closest?.("input,textarea")) return;
      e.preventDefault();
      e.stopPropagation();
      setProjHi(0);
      setProjMenu(true);
      trace("analytics.picker", { via: "key" });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [projMenu]);
  useEffect(() => {
    if (!projMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "#" || e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setProjMenu(false);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const n = projChoices.length;
        setProjHi((h) => (h + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        toggleProject(projChoices[projHi]);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projMenu, projHi, projChoices]);

  const filter = useMemo<DashboardFilter>(
    () => ({
      projects: selProjects.size
        ? [...selProjects].map((n) => (n === "" ? null : n))
        : null,
      priorities: selTiers.size
        ? [...selTiers].map((t) => (t === 0 ? null : t))
        : null,
    }),
    [selProjects, selTiers],
  );
  const hasFilter = selProjects.size > 0 || selTiers.size > 0;
  const clearFilter = () => {
    trace("analytics.filter.clear");
    setSelProjects(new Set());
    setSelTiers(new Set());
  };

  const toggleProject = (name: string) => {
    trace("analytics.filter", { project: name === "" ? "none" : name, on: !selProjects.has(name) });
    setSelProjects((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  const toggleTier = (t: number) => {
    trace("analytics.filter", { tier: t === 0 ? "none" : t, on: !selTiers.has(t) });
    setSelTiers((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  // Resolve the half-open [since, until) window from the active range, over
  // the app's logical days (6am→6am). `until` is the day *after* the target
  // so a day boundary is inclusive.
  const bounds = useMemo(() => {
    switch (range) {
      case "today": return { since: todayStr(), until: todayOffset(1) };
      case "week":  return { since: todayOffset(-6), until: todayOffset(1) };
      case "month": return { since: todayOffset(-29), until: todayOffset(1) };
      case "all":   return { since: undefined, until: undefined };
    }
  }, [range]);

  useEffect(() => {
    journalApi.dashboard({ since: bounds.since, until: bounds.until, filter, subject })
      .then(setDash)
      .catch((e) => log.warn("dashboard load failed", e));
    // Tracked time is a done-flavored dimension (work, not intake) — not
    // fetched in created mode.
    if (subject === "done") {
      timersApi.sessionTimeByDay({ since: bounds.since, until: bounds.until })
        .then(setTimes)
        .catch((e) => log.warn("session time load failed", e));
    } else {
      setTimes([]);
    }
  }, [bounds, filter, subject]);

  useEffect(() => {
    setDetail(null);
    if (!pickedDay) return;
    journalApi.dayDetail(pickedDay, subject, filter)
      .then(setDetail)
      .catch((e) => log.warn("day detail load failed", e));
  }, [pickedDay, filter, subject]);

  // Bring the open day card into view.
  useEffect(() => {
    if (!pickedDay) return;
    document
      .querySelector(".an-daycard")
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [pickedDay]);

  // Per-day tracked-time totals (sessions are a separate dimension; the
  // ledger shows the sum only).
  const timeByDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of times) map.set(t.day, (map.get(t.day) ?? 0) + t.seconds);
    return map;
  }, [times]);

  const pickDay = (d: string) => {
    if (d === pickedDay) {
      trace("analytics.pick", { day: d, on: false });
      setPickedDay(null);
      return;
    }
    trace("analytics.pick", { day: d, on: true });
    setPickedDay(d);
  };

  // Back from the day card to the ledger. A Today-picked card came from the
  // Today range pill, whose ledger is a single row — back restores the
  // working Week view.
  const backToLedger = () => {
    trace("analytics.pick", { day: pickedDay, on: false });
    setPickedDay(null);
    if (range === "today") setRange("week");
  };

  const ranges: { id: Range; label: string }[] = [
    { id: "today", label: "Today" },
    { id: "week", label: "Week" },
    { id: "month", label: "Month" },
    { id: "all", label: "All" },
  ];

  const heat = useMemo(() => new Map((dash?.heatmap ?? []).map((h) => [h.date, h.count])), [dash]);
  const cells = useMemo(() => monthCalendar(heat), [heat]);
  const monthLabel = new Date(todayStr() + "T00:00:00").toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
  const maxProject = Math.max(1, ...(dash?.projects ?? []).map((p) => p.count));
  const maxTier = Math.max(1, ...(dash?.priorities ?? []).map((t) => t.count));
  // Zero-count projects (roster rows with nothing in the range) hide until
  // the card head's chevron opens them.
  const zeroProjects = (dash?.projects ?? []).some((p) => p.count === 0);
  const projectRows = dash
    ? showZeroProjects
      ? dash.projects
      : dash.projects.filter((p) => p.count > 0)
    : [];

  // The ledger: one line per day that had any signal, newest first. Time
  // doesn't follow the scope filter, so while filtered it neither surfaces a
  // day nor shows as the day's total — only the per-task time inside the day
  // card (which rides the filtered task rows) renders. Created mode surfaces
  // creations only: time and the miss verdicts are done-flavored.
  const ledger = useMemo(() => {
    if (!dash) return [];
    return dash.days
      .filter((d) => d.count > 0 ||
        (subject === "done" && (d.dailyMissed + d.todayMissed > 0 ||
          (!hasFilter && (timeByDay.get(d.date) ?? 0) > 0))))
      .reverse();
  }, [dash, timeByDay, hasFilter, subject]);

  const today = todayStr();
  const dayCount = dash?.days.length ?? 0;
  const avg =
    dash && dayCount > 1 ? (dash.totals.count / dayCount).toFixed(1) : null;
  // The subject's noun, for every label the page renders.
  const noun = subject === "created" ? "created" : "done";

  // The picked day's card, derived from the day detail itself (not the range
  // stats), so a day outside the range — a calendar cell, the date field —
  // reads as correctly as one inside it.
  const pickedLabel = pickedDay
    ? pickedDay === today
      ? "Today"
      : new Date(pickedDay + "T00:00:00").toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
        })
    : "";
  const pickedMissed =
    detail && subject === "done"
      ? detail.fell.length + detail.dailyMissed.length
      : 0;
  const pickedSecs =
    detail && subject === "done" && !hasFilter
      ? detail.tasks.reduce((s, t) => s + t.secs, 0)
      : 0;

  // The `#` pill's label: the state of the project selection in pill language.
  const projLabel = (() => {
    if (selProjects.size === 0) return "# Projects";
    const names = [...selProjects];
    const first = names[0] === "" ? "none" : names[0];
    return `# ${first}${names.length > 1 ? ` +${names.length - 1}` : ""}`;
  })();

  return (
    <div className="analytics-view">
      {/* Range segments · date jump. The date field (like a calendar cell or
          a ledger row) opens that day's card. Right of them, the axis scope
          filters: the `#` project picker (multi-select popover) and the tier
          chips — every derivation follows them (see the module comment). */}
      <div className="filter-bar">
        {/* The subject toggle: what the page counts. Every card follows it;
            the done-only stats hide in created mode (the backend returns
            them zero — see dashboard.rs). */}
        <span className="subj" role="group" aria-label="What the page counts">
          {(["done", "created"] as const).map((s) => (
            <button
              key={s}
              className={`pill${subject === s ? " active" : ""}`}
              onClick={() => {
                if (s !== subject) trace("analytics.subject", { subject: s });
                setSubject(s);
              }}
              title={s === "done" ? "Count what you completed" : "Count what you created"}
            >{s === "done" ? "Done" : "Created"}</button>
          ))}
        </span>
        {ranges.map((r) => (
          <button
            key={r.id}
            className={`pill${range === r.id ? " active" : ""}`}
            onClick={() => {
              if (r.id !== range) trace("analytics.range", { range: r.id });
              setRange(r.id);
              // The Today range is one day — its pill opens that day's card;
              // every other range returns to the ledger.
              setPickedDay(r.id === "today" ? today : null);
            }}
          >{r.label}</button>
        ))}
        <input
          type="date"
          className={`date-jump${pickedDay ? " active" : ""}`}
          value={pickedDay ?? today}
          onChange={(e) => e.target.value && pickDay(e.target.value)}
          title="Pick a day to see its tasks"
        />
        <span className="anf">
          <span className="anf-wrap" ref={projMenuRef}>
            <button
              className={`pill anf-proj${selProjects.size ? " active" : ""}`}
              onClick={() => {
                if (!projMenu) trace("analytics.picker", { via: "pill" });
                setProjMenu(!projMenu);
              }}
              title="Scope the page to projects"
            >{projLabel} ▾</button>
            {projMenu && (
              <div className="anf-menu" role="menu">
                {projects.map((p, pi) => (
                  <button
                    key={p.id}
                    className={`anf-menu-item${selProjects.has(p.name) ? " on" : ""}${projHi === pi ? " hi" : ""}`}
                    onClick={() => toggleProject(p.name)}
                  >
                    <i className="anf-dot" style={{ background: projectColor(p.id) }} />
                    <span className="anf-name">{p.name}</span>
                    {selProjects.has(p.name) && <span className="anf-check">✓</span>}
                  </button>
                ))}
                <button
                  className={`anf-menu-item${selProjects.has("") ? " on" : ""}${projHi === projects.length ? " hi" : ""}`}
                  onClick={() => toggleProject("")}
                >
                  <i className="anf-dot hollow" />
                  <span className="anf-name">No project</span>
                  {selProjects.has("") && <span className="anf-check">✓</span>}
                </button>
              </div>
            )}
          </span>
          {([1, 2, 3, 0] as const).map((t) => (
            <button
              key={t}
              className={`pill anf-tier${selTiers.has(t) ? " active" : ""}`}
              onClick={() => toggleTier(t)}
              title={t === 0 ? "Scope to unmarked tasks" : `Scope to priority ${t}`}
              aria-label={t === 0 ? "Unmarked" : `Priority ${t}`}
            >
              <PriorityBars priority={t === 0 ? null : t} />
            </button>
          ))}
          {hasFilter && (
            <button className="pill anf-clear" onClick={clearFilter} title="Clear the scope filters">
              Clear
            </button>
          )}
        </span>
      </div>
      <div className="analytics">
        {dash && (
          <>
            <section className="an-card an-hero">
              <Stat value={dash.totals.count} label={noun === "created" ? "Created" : "Done"} accent />
              {avg != null && <Stat value={avg} label="Avg / day" />}
              {subject === "done" && (
                <>
                  <Stat value={dash.totals.streak} label="Day streak" />
                  <Stat value={dash.totals.dailyMissed} label="Daily missed" />
                  <Stat value={dash.totals.todayMissed} label="Today missed" />
                </>
              )}
            </section>

            <div className="an-row3">
              {/* Keyed on the rendered-sibling state: the split cards unmount
                  under their filtered axis, which re-widens this card's grid
                  track — and WKWebView doesn't re-resolve aspect-ratio cells
                  when their track changes size (the heatmap stayed big after
                  clearing a filter). Remounting the card re-resolves the
                  squares against the current width, in both directions. */}
              <section
                className="an-card an-activity"
                key={`act-${filter.projects ? 1 : 0}${filter.priorities ? 1 : 0}${
                  dash.projects.length > 0 ? 1 : 0
                }`}
              >
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
                            level(c.count) > 0 ? `l${level(c.count)}` : "",
                            c.future ? "future" : "",
                            c.isToday ? "today" : "",
                            pickedDay === c.date ? "picked" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          disabled={c.future}
                          title={`${formatReminder(c.date)}${c.count ? ` · ${c.count} ${noun}` : ""}`}
                          onClick={() => pickDay(c.date)}
                        >
                          <span className="n">{c.day}</span>
                          {c.count > 0 && <span className="c">{c.count}</span>}
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

              {/* A split card whose axis is filtered hides — the filtered view
                  already answers it, and a card scoped to the selection would
                  just restate the filter (100% X) while disagreeing with the
                  Done stat. */}
              {!filter.projects && dash.projects.length > 0 && (
                <section className="an-card an-projects">
                  <div className="an-card-title">
                    Projects
                    {zeroProjects && (
                      <button
                        className="an-expand"
                        onClick={() => setShowZeroProjects(!showZeroProjects)}
                        title={showZeroProjects ? "Hide empty projects" : "Show empty projects"}
                      >
                        <Chevron open={showZeroProjects} />
                      </button>
                    )}
                  </div>
                  {projectRows.map((p) => (
                    <BarRow
                      key={p.name ?? "__none"}
                      label={p.name ?? "none"}
                      title={p.name ? `#${p.name}` : "no project"}
                      count={p.count}
                      max={maxProject}
                    />
                  ))}
                  {projectRows.length === 0 && (
                    <div className="dash-empty">Nothing in this range.</div>
                  )}
                </section>
              )}

              {!filter.priorities && <PriorityCard tiers={dash.priorities} max={maxTier} />}
            </div>

            {/* Selecting a day swaps the ledger for that day's card — back
                returns to the list. Rows carry the axes at the right edge
                (bars then project, the item-row column order); missed habits
                sit time-less with the ○ mark. */}
            {pickedDay ? (
              <section className="an-card an-days an-daycard">
                <div className="an-card-title">
                  <span className="an-daycard-head">
                    <button className="an-back" onClick={backToLedger} title="Back to all days">
                      <Chevron className="left" />
                    </button>
                    <span className="an-daycard-day">{pickedLabel}</span>
                  </span>
                  <span className="hint">
                    {detail != null && detail.tasks.length > 0 && (
                      <span>{detail.tasks.length} {noun}</span>
                    )}
                    {detail != null && pickedMissed > 0 && <span>{pickedMissed} missed</span>}
                    {pickedSecs > 0 && <span>{formatDuration(pickedSecs)}</span>}
                  </span>
                </div>
                <div className="an-day-detail">
                  {detail == null && <div className="dd-empty">…</div>}
                  {detail?.tasks.map((t) => (
                    <div key={t.itemId} className={`dd-row ${noun}`}>
                      <span className="dd-mark">{noun === "created" ? "+" : "✓"}</span>
                      <span className="dd-time">{t.time}</span>
                      <span className="dd-text">{t.text}</span>
                      {subject === "done" && t.secs > 0 && (
                        <span className="dd-secs">{formatDuration(t.secs)}</span>
                      )}
                      <span className="dd-proj">{t.project ?? ""}</span>
                      <span className="dd-axis">
                        {t.priority != null && <PriorityBars priority={t.priority} />}
                      </span>
                    </div>
                  ))}
                  {detail?.fell.map((f) => (
                    <div key={`f-${f.time}-${f.text}`} className="dd-row fell">
                      <span className="dd-mark">↓</span>
                      <span className="dd-time">{f.time}</span>
                      <span className="dd-text">{f.text}</span>
                      <span className="dd-proj">{f.project ?? ""}</span>
                      <span className="dd-axis">
                        {f.priority != null && <PriorityBars priority={f.priority} />}
                      </span>
                    </div>
                  ))}
                  {detail?.dailyMissed.map((m) => (
                    <div key={`m-${m.text}-${m.project ?? ""}`} className="dd-row missed">
                      <span className="dd-mark">○</span>
                      <span className="dd-text">{m.text}</span>
                      <span className="dd-proj">{m.project ?? ""}</span>
                      <span className="dd-axis">
                        {m.priority != null && <PriorityBars priority={m.priority} />}
                      </span>
                    </div>
                  ))}
                  {detail != null &&
                    detail.tasks.length === 0 &&
                    detail.fell.length === 0 &&
                    detail.dailyMissed.length === 0 && (
                      <div className="dd-empty">Nothing that day.</div>
                    )}
                </div>
              </section>
            ) : (
              <section className="an-card an-days">
                <div className="an-card-title">Days</div>
                {ledger.length === 0 && (
                  <div className="dash-empty">No activity in this range.</div>
                )}
                {ledger.map((d) => {
                  const secs = timeByDay.get(d.date) ?? 0;
                  const missed = d.dailyMissed + d.todayMissed;
                  return (
                    <button
                      key={d.date}
                      className="an-day"
                      onClick={() => pickDay(d.date)}
                      title="Show this day's tasks"
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
                        {d.count > 0 && <span className="done">{d.count} {noun}</span>}
                        {subject === "done" && missed > 0 && <span>{missed} missed</span>}
                        {subject === "done" && !hasFilter && secs > 0 && (
                          <span className="time">{formatDuration(secs)}</span>
                        )}
                        <Chevron />
                      </span>
                    </button>
                  );
                })}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

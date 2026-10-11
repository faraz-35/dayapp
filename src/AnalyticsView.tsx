// AnalyticsView — the analytics page (top-right ≡): a dashboard of elevated
// cards synthesized over the append-only `actions` log, never the log itself.
// The filter bar is all dropdowns: a subject dropdown (done — effective
// completions, with the miss verdicts — or created, the tasks that entered
// the list; every card follows it, and the done-only stats (streak, both
// misses) hide in created mode), a range dropdown (Today/Week/Month/All —
// Custom is reached through the from–to fields), the from–to picker itself,
// and the three axis dropdowns (Projects / Priority / Delegation). A hero
// stats card, the current month as a
// calendar heatmap (intensity = the subject's per-day count), the
// distribution cards (project bars + a segmented priority bar), and the day
// ledger. Selecting a day — a ledger row, a calendar cell, or the Today
// pill (which scopes the range to today and opens its card) —
// replaces the ledger with that one day's card: label + counts, a back
// button, and the day at task level (done with times and axes, what fell,
// missed habits — the raw action log's textual home remains the CLI's
// --journal). The ledger paginates client-side, ten days a page. The
// calendar card's width is capped at the 480px-window card
// size, so a filtered axis unmounting its split card can't stretch the
// squares across the freed track; the projects card shows the top ten by
// count until its expand chevron opens the full roster.
// The filter bar also carries the axis scope filters — three multi-select
// dropdowns (Projects / Priority / Delegation; `#` opens Projects) — which
// every derivation follows via the backend's write-time snapshots (see
// dashboard.rs); a split
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
import { useFeatures } from "./features";

type Range = "today" | "week" | "month" | "all" | "custom";

/** The projects card shows this many roster rows until its chevron expands. */
const MAX_PROJECT_ROWS = 10;
/** The days ledger's page size. */
const DAYS_PER_PAGE = 10;

/** "Oct 11" — the range picker's field format. */
const fmtShort = (d: string): string =>
  new Date(d + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** The range presets — the range dropdown's options (Custom is reached
 *  through the from–to fields, never offered as a menu row). */
const RANGES: { id: Range; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "all", label: "All" },
];

const level = (done: number): number =>
  done === 0 ? 0 : done >= 7 ? 4 : done >= 4 ? 3 : done >= 2 ? 2 : 1;

/** The level colors as a shared scale — the calendar cells and its legend.
 *  Alphas ride --accent-rgb so every theme tints its own accent. */
const LEVEL_BG = [
  "var(--bg-hover)",
  "rgba(var(--accent-rgb), 0.28)",
  "rgba(var(--accent-rgb), 0.5)",
  "rgba(var(--accent-rgb), 0.75)",
  "var(--accent)",
];

/** Priority's segment colors — intensity steps of the one accent, the same
 *  scale language as the calendar (P1 carries the most weight). The alphas
 *  ride --accent-rgb so every theme tints its own accent. */
const TIER_BG: Record<string, string> = {
  "1": "var(--accent)",
  "2": "rgba(var(--accent-rgb), 0.62)",
  "3": "rgba(var(--accent-rgb), 0.36)",
  none: "rgba(var(--accent-rgb), 0.16)",
};

type Cell = {
  date: string;
  day: number;
  count: number;
  future: boolean;
  isToday: boolean;
};

/** The viewed month as a Monday-first grid: `lead` blanks, then one cell
 *  per day (intensity = that day's count of the active subject). Anchored on
 *  the app's logical today (6am→6am), so a 1am session fills yesterday's
 *  cell. Trailing blanks aren't needed — the CSS grid just ends the last row
 *  short. */
function monthCalendar(map: Map<string, number>, view: { y: number; m: number }): (Cell | null)[] {
  const today = todayStr();
  const year = view.y;
  const month = view.m;
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

export default function AnalyticsView({ ownerName }: { ownerName?: string | null }) {
  const [dash, setDash] = useState<DashboardStats | null>(null);
  const [times, setTimes] = useState<DayTaskTime[]>([]);
  const [detail, setDetail] = useState<DayDetail | null>(null);
  const features = useFeatures();
  const [range, setRange] = useState<Range>("week");
  // What the page counts — the toggle at the left of the filter bar. The
  // picked day survives a switch: the same day re-expands through the other
  // lens.
  const [subject, setSubject] = useState<DashboardSubject>("done");
  // The day whose card is open (and whose calendar cell is ringed). Picking
  // never re-scopes the stats — the range pills own that.
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  // The projects card shows the top ten by count until this chevron opens
  // the full roster (zero-count rows included).
  const [projectsExpanded, setProjectsExpanded] = useState(false);

  // ---- Axis scope filters (session-only, like the range) -------------------
  // Three multi-select dropdowns, one menu open at a time. Projects: "" in
  // the set is the "no project" bucket. Priority: 0 is the unmarked tier.
  // Delegation: one axis — a single selected side restricts, both sides
  // together are everyone (no restriction).
  const [projects, setProjects] = useState<Project[]>([]);
  const [selProjects, setSelProjects] = useState<Set<string>>(new Set());
  const [selTiers, setSelTiers] = useState<Set<number>>(new Set());
  const [selAgent, setSelAgent] = useState<Set<"agent" | "mine">>(new Set());
  const [openMenu, setOpenMenu] = useState<
    null | "subject" | "range" | "projects" | "priority" | "agent"
  >(null);
  const [menuHi, setMenuHi] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    projectsApi.list().then(setProjects).catch((e) => log.warn("projects load failed", e));
  }, []);

  const openFilterMenu = (menu: "subject" | "range" | "projects" | "priority" | "agent") => {
    if (openMenu !== menu) trace("analytics.picker", { menu });
    setOpenMenu(openMenu === menu ? null : menu);
    setMenuHi(0);
    setDpOpen(null);
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
  const toggleAgent = (a: "agent" | "mine") => {
    trace("analytics.filter", { agent: a, on: !selAgent.has(a) });
    setSelAgent((prev) => {
      const next = new Set(prev);
      if (next.has(a)) next.delete(a);
      else next.add(a);
      return next;
    });
  };

  // The open menu's rows as (key, toggle) — the keyboard's Enter targets. The
  // subject and range menus are radios: a pick applies and closes; the axis
  // menus are multi-selects and stay open.
  const menuItems: { key: string; toggle: () => void }[] = (() => {
    switch (openMenu) {
      case "subject":
        return (["done", "created"] as const).map((s) => ({
          key: s,
          toggle: () => {
            if (s !== subject) trace("analytics.subject", { subject: s });
            setSubject(s);
            setOpenMenu(null);
          },
        }));
      case "range":
        return RANGES.map((r) => ({
          key: r.id,
          toggle: () => {
            if (r.id !== range) trace("analytics.range", { range: r.id });
            setRange(r.id);
            // The Today range is one day — its pick opens that day's card;
            // every other range returns to the ledger.
            setPickedDay(r.id === "today" ? todayStr() : null);
            setOpenMenu(null);
          },
        }));
      case "projects":
        return [
          ...projects.map((p) => ({ key: p.name, toggle: () => toggleProject(p.name) })),
          { key: "", toggle: () => toggleProject("") },
        ];
      case "priority":
        return [1, 2, 3, 0].map((t) => ({ key: String(t), toggle: () => toggleTier(t) }));
      case "agent":
        return (["agent", "mine"] as const).map((a) => ({ key: a, toggle: () => toggleAgent(a) }));
      default:
        return [];
    }
  })();

  // The dropdowns stay keyboard-first like the picker they replace: `#` opens
  // the Projects menu, arrows walk the highlight, Enter toggles, Esc closes.
  // Capture phase so the global free-mode arrows don't scroll the page
  // underneath an open menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!openMenu) {
        if (e.key !== "#") return;
        const el = e.target as HTMLElement | null;
        if (el?.closest?.("input,textarea")) return;
        e.preventDefault();
        e.stopPropagation();
        setOpenMenu("projects");
        setMenuHi(0);
        trace("analytics.picker", { via: "key", menu: "projects" });
        return;
      }
      if ((e.target as HTMLElement | null)?.closest?.("input,textarea")) return;
      if (e.key === "Escape" || e.key === "#") {
        e.preventDefault();
        e.stopPropagation();
        setOpenMenu(null);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const n = menuItems.length;
        if (n > 0) setMenuHi((h) => (h + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        menuItems[menuHi]?.toggle();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openMenu, menuHi, menuItems]);

  // Both delegation sides together are everyone — only a single side restricts.
  const agentFilter: boolean | null = selAgent.size === 1 ? selAgent.has("agent") : null;

  const filter = useMemo<DashboardFilter>(
    () => ({
      projects: selProjects.size
        ? [...selProjects].map((n) => (n === "" ? null : n))
        : null,
      priorities: selTiers.size
        ? [...selTiers].map((t) => (t === 0 ? null : t))
        : null,
      agent: agentFilter,
    }),
    [selProjects, selTiers, agentFilter],
  );
  // A real restriction — drives the time-hiding and the split-card rules.
  const hasFilter = selProjects.size > 0 || selTiers.size > 0 || agentFilter !== null;
  // Any selection at all — the Clear button's condition.
  const anySelection = selProjects.size > 0 || selTiers.size > 0 || selAgent.size > 0;
  const clearFilter = () => {
    trace("analytics.filter.clear");
    setSelProjects(new Set());
    setSelTiers(new Set());
    setSelAgent(new Set());
  };

  // The custom window (the from–to picker): an empty side is open-ended.
  // Picking a day switches the toolbar to the Custom range; the pills remain
  // one-click presets whose windows refill the fields.
  const [custom, setCustom] = useState({ from: "", to: "" });
  const enterCustom = (from: string, to: string) => {
    setCustom({ from, to });
    setRange("custom");
    trace("analytics.range", { custom: true, from, to });
  };
  const [dpOpen, setDpOpen] = useState<null | "from" | "to">(null);
  const [dpMonth, setDpMonth] = useState(() => {
    const t = new Date(todayStr() + "T00:00:00");
    return { y: t.getFullYear(), m: t.getMonth() };
  });

  // Outside click anywhere off the filter bar closes whichever floating
  // surface is open. The bar is one ref — the menus live inside it, so a
  // click on a menu row never reads as "outside" (a per-group ref killed
  // the subject/range picks: their mousedown closed the menu before the
  // click could land).
  useEffect(() => {
    if (!openMenu && !dpOpen) return;
    const onDown = (e: MouseEvent) => {
      if (barRef.current?.contains(e.target as Node)) return;
      setOpenMenu(null);
      setDpOpen(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [openMenu, dpOpen]);

  // Resolve the half-open [since, until) window from the active range, over
  // the app's logical days (6am→6am). `until` is the day *after* the target
  // so a day boundary is inclusive.
  const dayBefore = (d: string) => {
    const t = new Date(d + "T00:00:00");
    t.setDate(t.getDate() - 1);
    return localDateStr(t);
  };

  const bounds = useMemo(() => {
    switch (range) {
      case "today": return { since: todayStr(), until: todayOffset(1) };
      case "week":  return { since: todayOffset(-6), until: todayOffset(1) };
      case "month": return { since: todayOffset(-29), until: todayOffset(1) };
      case "all":   return { since: undefined, until: undefined };
      case "custom": {
        const dayAfter = (d: string) => {
          const t = new Date(d + "T00:00:00");
          t.setDate(t.getDate() + 1);
          return localDateStr(t);
        };
        let { from, to } = custom;
        if (from && to && from > to) [from, to] = [to, from]; // dragged backwards
        return {
          since: from || undefined,
          until: to ? dayAfter(to) : undefined,
        };
      }
    }
  }, [range, custom]);

  // The picker fields always show the EFFECTIVE window (a pill's included);
  // picking a day on one side re-enters Custom with the other side seeded
  // from what was on screen — the native inputs' semantics, kept.
  const dispFrom = bounds.since ?? "";
  const dispTo = bounds.until ? dayBefore(bounds.until) : "";
  const openDp = (side: "from" | "to") => {
    if (dpOpen === side) {
      setDpOpen(null);
      return;
    }
    setOpenMenu(null);
    const v = side === "from" ? dispFrom : dispTo;
    const base = new Date((v || todayStr()) + "T00:00:00");
    setDpMonth({ y: base.getFullYear(), m: base.getMonth() });
    setDpOpen(side);
    trace("analytics.dates", { side });
  };
  const setDpSide = (side: "from" | "to", date: string) => {
    enterCustom(side === "from" ? date : dispFrom, side === "to" ? date : dispTo);
    setDpOpen(null);
  };
  const clearDpSide = (side: "from" | "to") => {
    enterCustom(side === "from" ? "" : dispFrom, side === "to" ? "" : dispTo);
    setDpOpen(null);
  };
  const shiftDpMonth = (delta: number) =>
    setDpMonth((v) => {
      const d = new Date(v.y, v.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });

  useEffect(() => {
    journalApi.dashboard({ since: bounds.since, until: bounds.until, filter, subject })
      .then(setDash)
      .catch((e) => log.warn("dashboard load failed", e));
    // Tracked time is a done-flavored dimension (work, not intake) — not
    // fetched in created mode.
    if (subject === "done" && features.timer) {
      timersApi.sessionTimeByDay({ since: bounds.since, until: bounds.until })
        .then(setTimes)
        .catch((e) => log.warn("session time load failed", e));
    } else {
      setTimes([]);
    }
  }, [bounds, filter, subject, features.timer]);

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

  const heat = useMemo(() => new Map((dash?.heatmap ?? []).map((h) => [h.date, h.count])), [dash]);
  // The viewed month — today's by default; the title arrows page it. Bounded
  // by data: back stops at the oldest month the heatmap actually covers,
  // forward at the current month (no future).
  const t0 = new Date(todayStr() + "T00:00:00");
  const [viewMonth, setViewMonth] = useState({ y: t0.getFullYear(), m: t0.getMonth() });
  const cells = useMemo(() => monthCalendar(heat, viewMonth), [heat, viewMonth]);
  const monthLabel = new Date(viewMonth.y, viewMonth.m, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
  const isCurrentMonth = viewMonth.y === t0.getFullYear() && viewMonth.m === t0.getMonth();
  const heatOldest = dash?.heatmap?.[0]?.date;
  const minMonth = heatOldest
    ? (() => { const d = new Date(heatOldest + "T00:00:00"); return { y: d.getFullYear(), m: d.getMonth() }; })()
    : { y: t0.getFullYear(), m: t0.getMonth() };
  const isOldestMonth = viewMonth.y === minMonth.y && viewMonth.m === minMonth.m;
  const shiftMonth = (delta: number) =>
    setViewMonth((v) => {
      const d = new Date(v.y, v.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  const maxProject = Math.max(1, ...(dash?.projects ?? []).map((p) => p.count));
  const maxTier = Math.max(1, ...(dash?.priorities ?? []).map((t) => t.count));
  const agentTotal = (dash?.agents.agent ?? 0) + (dash?.agents.mine ?? 0);
  const ownerLabel = ownerName?.trim() ? ownerName.trim() : "Mine";
  // The projects card: the backend returns the roster zero-filled, sorted by
  // count — the card shows the top ten until the head chevron opens it all.
  const projectRows = dash
    ? projectsExpanded
      ? dash.projects
      : dash.projects.slice(0, MAX_PROJECT_ROWS)
    : [];
  const projectsExpandable = (dash?.projects.length ?? 0) > MAX_PROJECT_ROWS;

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

  // The ledger paginates client-side, ten days a page — a fresh derivation
  // (range, subject, filter, tracked time) resets to the first page.
  const [dayPage, setDayPage] = useState(0);
  useEffect(() => setDayPage(0), [dash, hasFilter, subject, timeByDay]);
  const dayPages = Math.max(1, Math.ceil(ledger.length / DAYS_PER_PAGE));
  const dayPageIndex = Math.min(dayPage, dayPages - 1);
  const visibleDays = ledger.slice(
    dayPageIndex * DAYS_PER_PAGE,
    (dayPageIndex + 1) * DAYS_PER_PAGE,
  );

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

  // The date popover's month grid (a plain picker — no counts) and the range
  // tint between the two sides.
  const dpCells = dpOpen ? monthCalendar(new Map(), dpMonth) : [];
  const dpMonthLabel = new Date(dpMonth.y, dpMonth.m, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
  const dpIsCurrentMonth = dpMonth.y === t0.getFullYear() && dpMonth.m === t0.getMonth();
  const dpRange =
    dispFrom && dispTo
      ? [dispFrom < dispTo ? dispFrom : dispTo, dispFrom < dispTo ? dispTo : dispFrom]
      : null;

  return (
    <div className="analytics-view">
      {/* Range pills · the from–to range picker. Right of them, the axis
          scope filters: three multi-select dropdowns (Projects / Priority /
          Delegation) — every derivation follows them (see the module
          comment). */}
      <div className="filter-bar" ref={barRef}>
        {/* What the page counts — a dropdown (radio: a pick applies and
            closes). Every card follows it; the done-only stats hide in
            created mode (the backend returns them zero — see dashboard.rs). */}
        <span className="anf-wrap">
          <button
            className="pill anf-dd"
            onClick={() => openFilterMenu("subject")}
            title="What the page counts"
          >
            {subject === "done" ? "Done" : "Created"}
            <Chevron className={openMenu === "subject" ? "up" : "down"} />
          </button>
          {openMenu === "subject" && (
            <div className="anf-menu left" role="menu">
              {(["done", "created"] as const).map((s, si) => (
                <button
                  key={s}
                  className={`anf-menu-item${subject === s ? " on" : ""}${menuHi === si ? " hi" : ""}`}
                  onClick={() => {
                    if (s !== subject) trace("analytics.subject", { subject: s });
                    setSubject(s);
                    setOpenMenu(null);
                  }}
                >
                  <span className="anf-name">{s === "done" ? "Done" : "Created"}</span>
                  {subject === s && <span className="anf-check">✓</span>}
                </button>
              ))}
            </div>
          )}
        </span>
        {/* The range — a dropdown of the presets (Custom is reached through
            the from–to fields, never a menu row). A Today pick opens today's
            card, the others return to the ledger. */}
        <span className="anf-wrap">
          <button
            className="pill anf-dd"
            onClick={() => openFilterMenu("range")}
            title="The range"
          >
            {range === "custom" ? "Custom" : RANGES.find((r) => r.id === range)?.label}
            <Chevron className={openMenu === "range" ? "up" : "down"} />
          </button>
          {openMenu === "range" && (
            <div className="anf-menu left" role="menu">
              {RANGES.map((r, ri) => (
                <button
                  key={r.id}
                  className={`anf-menu-item${range === r.id ? " on" : ""}${menuHi === ri ? " hi" : ""}`}
                  onClick={() => {
                    if (r.id !== range) trace("analytics.range", { range: r.id });
                    setRange(r.id);
                    setPickedDay(r.id === "today" ? todayStr() : null);
                    setOpenMenu(null);
                  }}
                >
                  <span className="anf-name">{r.label}</span>
                  {range === r.id && <span className="anf-check">✓</span>}
                </button>
              ))}
            </div>
          )}
        </span>
        {/* The from–to range picker: two fields that always show the
            effective window (a pill's included); picking a day switches to
            the Custom range — an empty side is open-ended, a backwards pair
            auto-swaps. */}
        <span className="dp">
          <button
            className={`pill dp-btn${dpOpen === "from" ? " open" : ""}${range === "custom" ? " active" : ""}`}
            onClick={() => openDp("from")}
            title="Range start"
          >{dispFrom ? fmtShort(dispFrom) : "Start"}</button>
          <span className="dp-sep">–</span>
          <button
            className={`pill dp-btn${dpOpen === "to" ? " open" : ""}${range === "custom" ? " active" : ""}`}
            onClick={() => openDp("to")}
            title="Range end"
          >{dispTo ? fmtShort(dispTo) : "End"}</button>
          {dpOpen && (
            <div className="dp-pop">
              <div className="dp-head">
                <button
                  className="an-back"
                  onClick={() => shiftDpMonth(-1)}
                  aria-label="Previous month"
                  title="Previous month"
                >
                  <Chevron className="left" />
                </button>
                <span className="dp-month">{dpMonthLabel}</span>
                <button
                  className="an-back"
                  disabled={dpIsCurrentMonth}
                  onClick={() => shiftDpMonth(1)}
                  aria-label="Next month"
                  title={dpIsCurrentMonth ? "Current month" : "Next month"}
                >
                  <Chevron />
                </button>
              </div>
              <div className="dp-grid">
                {["M", "T", "W", "T", "F", "S", "S"].map((l, i) => (
                  <span key={`w${i}`} className="dp-wk">{l}</span>
                ))}
                {dpCells.map((c, i) =>
                  c == null ? (
                    <span key={`b${i}`} className="dp-cell blank" />
                  ) : (
                    <button
                      key={c.date}
                      className={[
                        "dp-cell",
                        (dpOpen === "from" ? dispFrom : dispTo) === c.date ? "sel" : "",
                        dpRange && c.date >= dpRange[0] && c.date <= dpRange[1] ? "inrange" : "",
                        c.isToday ? "today" : "",
                        c.future ? "future" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      disabled={c.future}
                      onClick={() => setDpSide(dpOpen, c.date)}
                    >{c.day}</button>
                  ),
                )}
              </div>
              {(dpOpen === "from" ? dispFrom : dispTo) && (
                <button className="dp-clear" onClick={() => clearDpSide(dpOpen)}>
                  Clear
                </button>
              )}
            </div>
          )}
        </span>
        <span className="anf">
          {features.projects && (
            <span className="anf-wrap">
              <button
                className={`pill anf-dd${selProjects.size ? " active" : ""}`}
                onClick={() => openFilterMenu("projects")}
                title="Scope the page to projects"
              >
                Projects{selProjects.size > 0 ? ` · ${selProjects.size}` : ""}
                <Chevron className={openMenu === "projects" ? "up" : "down"} />
              </button>
              {openMenu === "projects" && (
                <div className="anf-menu" role="menu">
                  {projects.map((p, pi) => (
                    <button
                      key={p.id}
                      className={`anf-menu-item${selProjects.has(p.name) ? " on" : ""}${menuHi === pi ? " hi" : ""}`}
                      onClick={() => toggleProject(p.name)}
                    >
                      <i className="anf-dot" style={{ background: projectColor(p.id) }} />
                      <span className="anf-name">{p.name}</span>
                      {selProjects.has(p.name) && <span className="anf-check">✓</span>}
                    </button>
                  ))}
                  <button
                    className={`anf-menu-item${selProjects.has("") ? " on" : ""}${menuHi === projects.length ? " hi" : ""}`}
                    onClick={() => toggleProject("")}
                  >
                    <i className="anf-dot hollow" />
                    <span className="anf-name">No project</span>
                    {selProjects.has("") && <span className="anf-check">✓</span>}
                  </button>
                </div>
              )}
            </span>
          )}
          {features.taskPriorities && (
            <span className="anf-wrap">
              <button
                className={`pill anf-dd${selTiers.size ? " active" : ""}`}
                onClick={() => openFilterMenu("priority")}
                title="Scope the page to priority tiers"
              >
                Priority{selTiers.size > 0 ? ` · ${selTiers.size}` : ""}
                <Chevron className={openMenu === "priority" ? "up" : "down"} />
              </button>
              {openMenu === "priority" && (
                <div className="anf-menu" role="menu">
                  {([1, 2, 3, 0] as const).map((t, ti) => (
                    <button
                      key={t}
                      className={`anf-menu-item${selTiers.has(t) ? " on" : ""}${menuHi === ti ? " hi" : ""}`}
                      onClick={() => toggleTier(t)}
                    >
                      <span className="anf-bars"><PriorityBars priority={t === 0 ? null : t} /></span>
                      <span className="anf-name">{t === 0 ? "Unmarked" : `P${t}`}</span>
                      {selTiers.has(t) && <span className="anf-check">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </span>
          )}
          {features.agent && (
            <span className="anf-wrap">
              <button
                className={`pill anf-dd${selAgent.size ? " active" : ""}`}
                onClick={() => openFilterMenu("agent")}
                title="Scope the page by who executes"
              >
                Delegation{selAgent.size > 0 ? ` · ${selAgent.size}` : ""}
                <Chevron className={openMenu === "agent" ? "up" : "down"} />
              </button>
              {openMenu === "agent" && (
                <div className="anf-menu" role="menu">
                  {(["agent", "mine"] as const).map((a, ai) => (
                    <button
                      key={a}
                      className={`anf-menu-item${selAgent.has(a) ? " on" : ""}${menuHi === ai ? " hi" : ""}`}
                      onClick={() => toggleAgent(a)}
                    >
                      <span className="anf-name">{a === "agent" ? "Agent" : ownerLabel}</span>
                      {selAgent.has(a) && <span className="anf-check">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </span>
          )}
          {anySelection && (
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
                  <span className="an-cal-nav">
                    <button
                      className="an-back"
                      onClick={() => shiftMonth(-1)}
                      disabled={isOldestMonth}
                      title={isOldestMonth ? "Oldest month with data" : "Previous month"}
                      aria-label="Previous month"
                    >
                      <Chevron className="left" />
                    </button>
                    {monthLabel}
                    <button
                      className="an-back"
                      onClick={() => shiftMonth(1)}
                      disabled={isCurrentMonth}
                      title={isCurrentMonth ? "Current month" : "Next month"}
                      aria-label="Next month"
                    >
                      <Chevron />
                    </button>
                  </span>
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
              {features.projects && !filter.projects && dash.projects.length > 0 && (
                <section className="an-card an-projects">
                  <div className="an-card-title">Projects</div>
                  <div className="an-proj-body">
                    {projectRows.map((p) => (
                      <BarRow
                        key={p.name ?? "__none"}
                        label={p.name ?? "none"}
                        title={p.name ?? "no project"}
                        count={p.count}
                        max={maxProject}
                      />
                    ))}
                    {projectsExpandable && !projectsExpanded && (
                      <>
                        {/* The fade + chip ride over the tenth row — the hint
                            that the roster continues below the fold. */}
                        <span className="an-proj-fade" aria-hidden="true" />
                        <button
                          className="an-proj-more"
                          onClick={() => setProjectsExpanded(true)}
                          title="Show all projects"
                          aria-label="Show all projects"
                        >
                          <Chevron open />
                        </button>
                      </>
                    )}
                    {projectsExpandable && projectsExpanded && (
                      <button
                        className="an-proj-less"
                        onClick={() => setProjectsExpanded(false)}
                        title="Show the top ten"
                        aria-label="Show the top ten"
                      >
                        <Chevron className="up" />
                      </button>
                    )}
                  </div>
                  {projectRows.length === 0 && (
                    <div className="dash-empty">Nothing in this range.</div>
                  )}
                </section>
              )}

              {/* The third grid column stacks Priority over the Agent vs Mine
                  comparison — half height each. The comparison hides while the
                  agent axis itself is filtered (the standing split-card rule:
                  a filtered view can't compare against itself). */}
              {(features.taskPriorities || features.agent) && (!filter.priorities || !filter.agent) && (
                <div className="an-stack">
                  {features.taskPriorities && !filter.priorities && <PriorityCard tiers={dash.priorities} max={maxTier} />}
                  {features.agent && !filter.agent && (
                    <section className="an-card">
                      <div className="an-card-title">Delegation</div>
                      <div className="an-segbar">
                        <span
                          className="seg"
                          style={{ width: agentTotal > 0 ? `${(dash.agents.agent / agentTotal) * 100}%` : "0%", background: TIER_BG["1"] }}
                        />
                        <span
                          className="seg"
                          style={{ width: agentTotal > 0 ? `${(dash.agents.mine / agentTotal) * 100}%` : "0%", background: TIER_BG["3"] }}
                        />
                      </div>
                      <div className="an-seg-legend">
                        <span className="leg">Agent {dash.agents.agent}</span>
                        <span className="leg">{ownerLabel} {dash.agents.mine}</span>
                      </div>
                    </section>
                  )}
                </div>
              )}
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
                    {features.timer && pickedSecs > 0 && <span>{formatDuration(pickedSecs)}</span>}
                  </span>
                </div>
                <div className="an-day-detail">
                  {detail == null && <div className="dd-empty">…</div>}
                  {detail?.tasks.map((t) => (
                    <div key={t.itemId} className={`dd-row ${noun}`}>
                      <span className="dd-mark">{noun === "created" ? "+" : "✓"}</span>
                      <span className="dd-time">{t.time}</span>
                      <span className="dd-text">{t.text}</span>
                      {subject === "done" && features.timer && t.secs > 0 && (
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
                {visibleDays.map((d) => {
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
                          <span className="time">{features.timer && formatDuration(secs)}</span>
                        )}
                        <Chevron />
                      </span>
                    </button>
                  );
                })}
                {dayPages > 1 && (
                  <div className="an-pager">
                    <button
                      className="an-back"
                      disabled={dayPageIndex === 0}
                      onClick={() => setDayPage(dayPageIndex - 1)}
                      title="Previous days"
                      aria-label="Previous days"
                    >
                      <Chevron className="left" />
                    </button>
                    <span>{dayPageIndex + 1} / {dayPages}</span>
                    <button
                      className="an-back"
                      disabled={dayPageIndex === dayPages - 1}
                      onClick={() => setDayPage(dayPageIndex + 1)}
                      title="More days"
                      aria-label="More days"
                    >
                      <Chevron />
                    </button>
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

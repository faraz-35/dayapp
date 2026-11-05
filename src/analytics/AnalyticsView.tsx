// AnalyticsView — the analytics page (top-right ≡): a dashboard of elevated
// cards synthesized over the append-only `actions` log, never the log itself.
// This file is the shell: it owns the state the whole page derives from —
// subject (the Done/Created/Missed tabs), range (the window), the axis scope
// selections, the picked day — and the fetches that follow them; everything
// rendered is a focused component beside this file (FilterBar, HeatmapCard,
// TasksCard, cards.tsx).
//
// The toolbar: three subject tabs centered (what every card counts — Done is
// the effective completions with the miss verdicts, Created the tasks that
// entered the list, Missed makes those verdicts the subject), a range
// dropdown (Week / Month — the current calendar week and month — Last 7 /
// Last 30 days rolling back from today, All; Custom is reached through the
// from–to fields), the from–to picker, and the three axis multi-selects.
// Default range: Month.
//
// The Month range and the calendar are ONE state: the bounds derive from the
// viewed month, so paging the heatmap moves the whole dashboard with it.
// Every other preset ignores the viewed month — browsing the calendar is
// preview-only until Month is picked again (which snaps back to the current
// month). Selecting a day — a calendar cell — swaps the calendar card itself
// for that day's detail (HeatmapCard); picking never re-scopes the stats.
//
// All derivation lives in src-tauri/src/dashboard.rs; a filter whose axis is
// selected scopes every card (a split card whose axis is filtered hides —
// the filtered view already answers it), and tracked time deliberately
// doesn't follow (sessions carry no axes; the day detail's per-task seconds
// ride the filtered rows).

import { useEffect, useMemo, useState } from "react";
import { journalApi, localDateStr, projectsApi, todayOffset, todayStr } from "../lib";
import type { DashboardFilter, DashboardStats, DashboardSubject, DayDetail, Project } from "../lib";
import { useFeatures } from "../features";
import { log } from "../log";
import { trace } from "../devlog";
import FilterBar, { type Range } from "./FilterBar";
import HeatmapCard from "./HeatmapCard";
import TasksCard from "./TasksCard";
import { DelegationCard, PriorityCard, ProjectsCard, StatCard } from "./cards";
import { currentMonth, shiftMonth as monthShift } from "./calendar";

export default function AnalyticsView({ ownerName }: { ownerName?: string | null }) {
  const features = useFeatures();

  // ---- What the page counts -----------------------------------------------
  // The subject tabs. The picked day survives a switch: the same day
  // re-expands through the other lens.
  const [subject, setSubject] = useState<DashboardSubject>("done");

  // ---- The window -----------------------------------------------------------
  // range picks the preset; viewMonth is the calendar's month. Under Month
  // they are one: the bounds derive from viewMonth, so paging the calendar
  // moves the dashboard. Custom comes through the from–to fields (an empty
  // side is open-ended); the presets refill the fields.
  const [range, setRange] = useState<Range>("month");
  const [viewMonth, setViewMonth] = useState(currentMonth);
  const [custom, setCustom] = useState({ from: "", to: "" });

  const pickRange = (r: Range) => {
    setRange(r);
    if (r === "month") {
      // The preset names the CURRENT month — the calendar snaps back to it.
      setViewMonth(currentMonth());
    }
  };
  const enterCustom = (from: string, to: string) => {
    setCustom({ from, to });
    setRange("custom");
    trace("analytics.range", { custom: true, from, to });
  };
  const shiftViewMonth = (delta: number) => setViewMonth((v) => monthShift(v, delta));

  // The half-open [since, until) window over the app's logical days
  // (6am→6am); `until` is the day *after* the target so a day boundary is
  // inclusive. Under Month, viewMonth feeds the bounds directly — the
  // heatmap's arrows drive the whole dashboard.
  const bounds = useMemo<{ since?: string; until?: string }>(() => {
    switch (range) {
      case "month": {
        const first = new Date(viewMonth.y, viewMonth.m, 1);
        const next = new Date(viewMonth.y, viewMonth.m + 1, 1);
        return { since: localDateStr(first), until: localDateStr(next) };
      }
      case "week": {
        // The current calendar week: Monday through Sunday.
        const t = new Date(todayStr() + "T00:00:00");
        const monday = new Date(t);
        monday.setDate(t.getDate() - ((t.getDay() + 6) % 7));
        const weekEnd = new Date(monday);
        weekEnd.setDate(monday.getDate() + 7);
        return { since: localDateStr(monday), until: localDateStr(weekEnd) };
      }
      case "d7":
        return { since: todayOffset(-6), until: todayOffset(1) };
      case "d30":
        return { since: todayOffset(-29), until: todayOffset(1) };
      case "all":
        return { since: undefined, until: undefined };
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
  }, [range, viewMonth, custom]);

  // The picker fields always show the EFFECTIVE window (a pill's included).
  const dayBefore = (d: string) => {
    const t = new Date(d + "T00:00:00");
    t.setDate(t.getDate() - 1);
    return localDateStr(t);
  };
  const dispFrom = bounds.since ?? "";
  const dispTo = bounds.until ? dayBefore(bounds.until) : "";

  // ---- Axis scope filters (session-only, like the range) -------------------
  // Three multi-select dropdowns. Projects: "" in the set is the "no project"
  // bucket. Priority: 0 is the unmarked tier. Delegation: one axis — a single
  // selected side restricts, both sides together are everyone.
  const [projects, setProjects] = useState<Project[]>([]);
  const [selProjects, setSelProjects] = useState<Set<string>>(new Set());
  const [selTiers, setSelTiers] = useState<Set<number>>(new Set());
  const [selAgent, setSelAgent] = useState<Set<"agent" | "mine">>(new Set());

  useEffect(() => {
    projectsApi.list().then(setProjects).catch((e) => log.warn("projects load failed", e));
  }, []);

  // One toggle for all three axes: flip the value in the set, trace it.
  const toggleIn = <T,>(v: T, set: Set<T>, setSet: (s: Set<T>) => void, traceData: Record<string, unknown>) => {
    trace("analytics.filter", traceData);
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    setSet(next);
  };
  const toggleProject = (name: string) =>
    toggleIn(name, selProjects, setSelProjects, { project: name === "" ? "none" : name });
  const toggleTier = (tier: number) =>
    toggleIn(tier, selTiers, setSelTiers, { tier: tier === 0 ? "none" : tier });
  const toggleAgent = (side: "agent" | "mine") =>
    toggleIn(side, selAgent, setSelAgent, { agent: side });

  const clearFilter = () => {
    trace("analytics.filter.clear");
    setSelProjects(new Set());
    setSelTiers(new Set());
    setSelAgent(new Set());
  };

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
  const hasFilter = filter.projects != null || filter.priorities != null || filter.agent != null;

  // ---- The fetched derivations ----------------------------------------------
  const [dash, setDash] = useState<DashboardStats | null>(null);
  const [detail, setDetail] = useState<DayDetail | null>(null);
  const [pickedDay, setPickedDay] = useState<string | null>(null);

  useEffect(() => {
    journalApi.dashboard({ since: bounds.since, until: bounds.until, filter, subject })
      .then(setDash)
      .catch((e) => log.warn("dashboard load failed", e));
    // Deps are the bounds' VALUES, not the object: paging the calendar
    // under a non-Month preset re-derives identical bounds, and the refetch
    // must not churn.
  }, [bounds.since, bounds.until, filter, subject]);

  useEffect(() => {
    setDetail(null);
    if (!pickedDay) return;
    journalApi.dayDetail(pickedDay, subject, filter)
      .then(setDetail)
      .catch((e) => log.warn("day detail load failed", e));
  }, [pickedDay, filter, subject]);

  // The calendar card's two states: a cell opens that day in it (picking
  // never re-scopes the stats — the range owns that); back unpicks.
  const pickDay = (d: string) => {
    trace("analytics.pick", { day: d, on: true });
    setPickedDay(d);
  };
  const backToCalendar = () => {
    trace("analytics.pick", { day: pickedDay, on: false });
    setPickedDay(null);
  };

  // ---- Composition ------------------------------------------------------
  const ownerLabel = ownerName?.trim() ? ownerName.trim() : "Mine";
  const noun = subject;
  const dayCount = dash?.days.length ?? 0;
  const avg = dash && dayCount > 1 ? (dash.totals.count / dayCount).toFixed(1) : null;
  const maxTier = Math.max(1, ...(dash?.priorities ?? []).map((t) => t.count));
  const heat = useMemo(
    () => new Map((dash?.heatmap ?? []).map((h) => [h.date, h.count])),
    [dash],
  );
  // Keyed on the rendered-sibling state: the split cards unmount under their
  // filtered axis, which re-widens the calendar's grid track — and WKWebView
  // doesn't re-resolve aspect-ratio cells when their track changes size (the
  // heatmap stayed big after clearing a filter). Remounting re-resolves the
  // squares against the current width, in both directions.
  const trackKey = `act-${filter.projects ? 1 : 0}${filter.priorities ? 1 : 0}${
    dash?.projects.length != null && dash.projects.length > 0 ? 1 : 0
  }`;

  return (
    <div className="analytics-view">
      <FilterBar
        subject={subject}
        onSubject={setSubject}
        range={range}
        onRange={pickRange}
        onCustomRange={enterCustom}
        axes={{
          selProjects,
          selTiers,
          selAgent,
          toggleProject,
          toggleTier,
          toggleAgent,
          clear: clearFilter,
        }}
        projects={projects}
        ownerLabel={ownerLabel}
        dispFrom={dispFrom}
        dispTo={dispTo}
      />
      <div className="analytics">
        {dash && (
          <>
            {/* Hero stats — one card, evenly spread, each metric centered in
                its column. Each lens shows its own numbers: Done → done;
                Created → creations; Missed → the two miss verdicts. The
                streak is gone — the heatmap's lit cells already say it. */}
            <section className="an-card an-hero">
              <StatCard value={dash.totals.count} label={cap(noun)} accent />
              {avg != null && <StatCard value={avg} label="Avg / day" />}
              {subject === "missed" && (
                <>
                  <StatCard value={dash.totals.dailyMissed} label="Daily missed" />
                  <StatCard value={dash.totals.todayMissed} label="Today missed" />
                </>
              )}
            </section>

            <div className="an-row3">
              {/* The calendar card — the day index and the day detail in one
                  (see HeatmapCard). The month is THIS state: under the Month
                  range, its arrows move the whole dashboard. */}
              <HeatmapCard
                heat={heat}
                oldest={dash.heatmap[0]?.date}
                viewMonth={viewMonth}
                onShiftMonth={shiftViewMonth}
                pickedDay={pickedDay}
                detail={detail}
                subject={subject}
                filtered={hasFilter}
                onPick={pickDay}
                onBack={backToCalendar}
                trackKey={trackKey}
              />
              {/* A split card whose axis is filtered hides — the filtered
                  view already answers it, and a card scoped to the selection
                  would just restate the filter (100% X) while disagreeing
                  with the hero stat. */}
              {features.taskProjects && !filter.projects && dash.projects.length > 0 && (
                <ProjectsCard projects={dash.projects} />
              )}
              {(features.taskPriorities || features.agent) && (!filter.priorities || !filter.agent) && (
                <div className="an-stack">
                  {features.taskPriorities && !filter.priorities && (
                    <PriorityCard tiers={dash.priorities} max={maxTier} />
                  )}
                  {features.agent && !filter.agent && (
                    <DelegationCard agents={dash.agents} ownerLabel={ownerLabel} />
                  )}
                </div>
              )}
            </div>

            {/* The window's tasks, paginated — the row-level view under the
                aggregates, following the same subject + scope. */}
            <TasksCard
              since={bounds.since}
              until={bounds.until}
              filter={filter}
              subject={subject}
            />
          </>
        )}
      </div>
    </div>
  );
}

/** "Done" / "Created" / "Missed" — the hero's label. */
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

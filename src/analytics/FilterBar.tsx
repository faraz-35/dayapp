// FilterBar.tsx — the analytics toolbar: the subject tabs (what the page
// counts — Done / Created / Missed, centered), the range dropdown, the
// from–to picker with its month-grid popover, and the three axis scope
// dropdowns (Projects / Priority / Delegation) + Clear. The bar owns its
// floating-surface state (which menu or popover is open, the keyboard walk,
// outside-click close); the selections behind the axis menus are the shell's
// (they feed every fetch) — this component renders and toggles them through
// the AxisFilterHandle. Every derivation on the page follows what lands here.

import { useEffect, useRef, useState } from "react";
import { PriorityBars } from "../components/PriorityBars";
import { projectColor, todayStr } from "../lib";
import type { DashboardSubject, Project } from "../lib";
import { useFeatures } from "../features";
import { trace } from "../devlog";
import Chevron from "./Chevron";
import { currentMonth, fmtDay, monthCalendar, shiftMonth, type ViewMonth } from "./calendar";
import type { AxisFilterHandle } from "./types";

/** The range presets — the range dropdown's options. Week/Month are the
 *  CURRENT calendar week/month (Month is also what the heatmap drives — see
 *  AnalyticsView's bounds); the N-day presets roll back from today; All is
 *  the whole log; Custom is reached through the from–to fields, never
 *  offered as a menu row. */
const RANGES: { id: Range; label: string }[] = [
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "d7", label: "Last 7 days" },
  { id: "d30", label: "Last 30 days" },
  { id: "all", label: "All" },
];

export type Range = "week" | "month" | "d7" | "d30" | "all" | "custom";

/** The subject tabs, in tab order. The string is the label and the noun. */
const SUBJECTS: DashboardSubject[] = ["done", "created", "missed"];

type Menu = "range" | "projects" | "priority" | "agent";

export default function FilterBar({
  subject,
  onSubject,
  range,
  onRange,
  onCustomRange,
  axes,
  projects,
  ownerLabel,
  dispFrom,
  dispTo,
}: {
  subject: DashboardSubject;
  onSubject: (s: DashboardSubject) => void;
  range: Range;
  onRange: (r: Range) => void;
  /** Enter the Custom range with both sides (an empty side is open-ended). */
  onCustomRange: (from: string, to: string) => void;
  axes: AxisFilterHandle;
  projects: Project[];
  ownerLabel: string;
  /** The effective window's inclusive ends — what the fields show. */
  dispFrom: string;
  dispTo: string;
}) {
  const [openMenu, setOpenMenu] = useState<Menu | null>(null);
  const [menuHi, setMenuHi] = useState(0);
  const [dpOpen, setDpOpen] = useState<null | "from" | "to">(null);
  const [dpMonth, setDpMonth] = useState<ViewMonth>(currentMonth);
  const barRef = useRef<HTMLDivElement>(null);
  const features = useFeatures();

  const openMenuOr = (menu: Menu) => {
    if (openMenu !== menu) trace("analytics.picker", { menu });
    setOpenMenu(openMenu === menu ? null : menu);
    setMenuHi(0);
    setDpOpen(null);
  };

  // The open menu's rows as (key, toggle) — the keyboard's Enter targets.
  // The range menu is a radio (a pick applies and closes); the axis menus
  // are multi-selects and stay open.
  const menuItems: { key: string; toggle: () => void }[] = (() => {
    switch (openMenu) {
      case "range":
        return RANGES.map((r) => ({
          key: r.id,
          toggle: () => {
            if (r.id !== range) trace("analytics.range", { range: r.id });
            onRange(r.id);
            setOpenMenu(null);
          },
        }));
      case "projects":
        return [
          ...projects.map((p) => ({ key: p.name, toggle: () => axes.toggleProject(p.name) })),
          { key: "", toggle: () => axes.toggleProject("") },
        ];
      case "priority":
        return [1, 2, 3, 0].map((t) => ({ key: String(t), toggle: () => axes.toggleTier(t) }));
      case "agent":
        return (["agent", "mine"] as const).map((a) => ({ key: a, toggle: () => axes.toggleAgent(a) }));
      default:
        return [];
    }
  })();

  // The dropdowns stay keyboard-first like the picker they replaced: `#`
  // opens the Projects menu, arrows walk the highlight, Enter toggles, Esc
  // closes. Capture phase so the global free-mode arrows don't scroll the
  // page underneath an open menu.
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

  // Outside click anywhere off the bar closes whichever floating surface is
  // open. The bar is one ref — the menus live inside it, so a click on a
  // menu row never reads as "outside" (a per-group ref killed the range
  // picks: their mousedown closed the menu before the click could land).
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

  // The date popover: opens on one side, seeded to that side's month.
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
    onCustomRange(side === "from" ? date : dispFrom, side === "to" ? date : dispTo);
    setDpOpen(null);
  };
  const clearDpSide = (side: "from" | "to") => {
    onCustomRange(side === "from" ? "" : dispFrom, side === "to" ? "" : dispTo);
    setDpOpen(null);
  };

  // The popover's month grid (a plain picker — no counts) and the range tint
  // between the two sides.
  const t0 = currentMonth();
  const dpCells = dpOpen ? monthCalendar(new Map(), dpMonth) : [];
  const dpMonthLabel = new Date(dpMonth.y, dpMonth.m, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
  const dpIsCurrentMonth = dpMonth.y === t0.y && dpMonth.m === t0.m;
  const dpRange =
    dispFrom && dispTo
      ? [dispFrom < dispTo ? dispFrom : dispTo, dispFrom < dispTo ? dispTo : dispFrom]
      : null;
  const dpSideValue = dpOpen === "from" ? dispFrom : dispTo;

  return (
    <div className="filter-bar" ref={barRef}>
      {/* The range — a dropdown of the presets (Custom is reached through
          the from–to fields, never a menu row). */}
      <span className="anf-wrap">
        <button className="pill anf-dd" onClick={() => openMenuOr("range")} title="The range">
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
                  onRange(r.id);
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
      {/* The from–to range picker: two fields that always show the effective
          window (a pill's included); picking a day switches to the Custom
          range — an empty side is open-ended, a backwards pair auto-swaps. */}
      <span className="dp">
        <button
          className={`pill dp-btn${dpOpen === "from" ? " open" : ""}${range === "custom" ? " active" : ""}`}
          onClick={() => openDp("from")}
          title="Range start"
        >{dispFrom ? fmtDay(dispFrom) : "Start"}</button>
        <span className="dp-sep">–</span>
        <button
          className={`pill dp-btn${dpOpen === "to" ? " open" : ""}${range === "custom" ? " active" : ""}`}
          onClick={() => openDp("to")}
          title="Range end"
        >{dispTo ? fmtDay(dispTo) : "End"}</button>
        {dpOpen && (
          <div className="dp-pop">
            <div className="dp-head">
              <button
                className="an-back"
                onClick={() => setDpMonth((v) => shiftMonth(v, -1))}
                aria-label="Previous month"
                title="Previous month"
              >
                <Chevron className="left" />
              </button>
              <span className="dp-month">{dpMonthLabel}</span>
              <button
                className="an-back"
                disabled={dpIsCurrentMonth}
                onClick={() => setDpMonth((v) => shiftMonth(v, 1))}
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
                      dpSideValue === c.date ? "sel" : "",
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
            {dpSideValue && (
              <button className="dp-clear" onClick={() => clearDpSide(dpOpen)}>
                Clear
              </button>
            )}
          </div>
        )}
      </span>
      {/* The two springs center the subject tabs between the range fields
          and the axis dropdowns (equal flex both sides); on a wrapped line
          they collapse to a minimum gap. */}
      <span className="bar-spring" />
      {/* The subject — three tabs centered in the bar. Every card follows
          the pick; the done-only stats hide in the other lenses (the backend
          returns them zero — see dashboard.rs). */}
      <span className="anf-tabs">
        {SUBJECTS.map((s) => (
          <button
            key={s}
            className={`anf-tab${subject === s ? " active" : ""}`}
            onClick={() => {
              if (s !== subject) trace("analytics.subject", { subject: s });
              onSubject(s);
            }}
          >
            {s[0].toUpperCase() + s.slice(1)}
          </button>
        ))}
      </span>
      <span className="bar-spring" />
      <span className="anf">
        {features.taskProjects && (
          <span className="anf-wrap">
            <button
              className={`pill anf-dd${axes.selProjects.size ? " active" : ""}`}
              onClick={() => openMenuOr("projects")}
              title="Scope the page to projects"
            >
              Projects{axes.selProjects.size > 0 ? ` · ${axes.selProjects.size}` : ""}
              <Chevron className={openMenu === "projects" ? "up" : "down"} />
            </button>
            {openMenu === "projects" && (
              <div className="anf-menu" role="menu">
                {projects.map((p, pi) => (
                  <button
                    key={p.id}
                    className={`anf-menu-item${axes.selProjects.has(p.name) ? " on" : ""}${menuHi === pi ? " hi" : ""}`}
                    onClick={() => axes.toggleProject(p.name)}
                  >
                    <i className="anf-dot" style={{ background: projectColor(p.id) }} />
                    <span className="anf-name">{p.name}</span>
                    {axes.selProjects.has(p.name) && <span className="anf-check">✓</span>}
                  </button>
                ))}
                <button
                  className={`anf-menu-item${axes.selProjects.has("") ? " on" : ""}${menuHi === projects.length ? " hi" : ""}`}
                  onClick={() => axes.toggleProject("")}
                >
                  <i className="anf-dot hollow" />
                  <span className="anf-name">No project</span>
                  {axes.selProjects.has("") && <span className="anf-check">✓</span>}
                </button>
              </div>
            )}
          </span>
        )}
        {features.taskPriorities && (
          <span className="anf-wrap">
            <button
              className={`pill anf-dd${axes.selTiers.size ? " active" : ""}`}
              onClick={() => openMenuOr("priority")}
              title="Scope the page to priority tiers"
            >
              Priority{axes.selTiers.size > 0 ? ` · ${axes.selTiers.size}` : ""}
              <Chevron className={openMenu === "priority" ? "up" : "down"} />
            </button>
            {openMenu === "priority" && (
              <div className="anf-menu" role="menu">
                {([1, 2, 3, 0] as const).map((t, ti) => (
                  <button
                    key={t}
                    className={`anf-menu-item${axes.selTiers.has(t) ? " on" : ""}${menuHi === ti ? " hi" : ""}`}
                    onClick={() => axes.toggleTier(t)}
                  >
                    <span className="anf-bars"><PriorityBars priority={t === 0 ? null : t} /></span>
                    <span className="anf-name">{t === 0 ? "Unmarked" : `P${t}`}</span>
                    {axes.selTiers.has(t) && <span className="anf-check">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </span>
        )}
        {features.agent && (
          <span className="anf-wrap">
            <button
              className={`pill anf-dd${axes.selAgent.size ? " active" : ""}`}
              onClick={() => openMenuOr("agent")}
              title="Scope the page by who executes"
            >
              Delegation{axes.selAgent.size > 0 ? ` · ${axes.selAgent.size}` : ""}
              <Chevron className={openMenu === "agent" ? "up" : "down"} />
            </button>
            {openMenu === "agent" && (
              <div className="anf-menu" role="menu">
                {(["agent", "mine"] as const).map((a, ai) => (
                  <button
                    key={a}
                    className={`anf-menu-item${axes.selAgent.has(a) ? " on" : ""}${menuHi === ai ? " hi" : ""}`}
                    onClick={() => axes.toggleAgent(a)}
                  >
                    <span className="anf-name">{a === "agent" ? "Agent" : ownerLabel}</span>
                    {axes.selAgent.has(a) && <span className="anf-check">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </span>
        )}
        {(axes.selProjects.size > 0 || axes.selTiers.size > 0 || axes.selAgent.size > 0) && (
          <button className="pill anf-clear" onClick={axes.clear} title="Clear the scope filters">
            Clear
          </button>
        )}
      </span>
    </div>
  );
}

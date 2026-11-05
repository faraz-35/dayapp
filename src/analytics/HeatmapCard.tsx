// HeatmapCard.tsx — the calendar card, the analytics page's day index AND
// day detail. Two states swap inside the one card: the month heatmap (the
// ‹ › arrows page it, bounded by data), and — while a day is picked — that
// day's task-level detail under a back arrow. The month itself is the
// shell's (it drives the range bounds under the Month preset); the picked
// day follows its own month here, so back lands on a calendar that contains
// the day. Keyed on `trackKey` (the shell's rendered-sibling state): WKWebView
// doesn't re-resolve the aspect-ratio cells when their grid track re-widens
// on filter changes, and remounting the card re-resolves the squares.

import { useEffect, useMemo } from "react";
import { PriorityBars } from "../components/PriorityBars";
import { formatDuration, formatReminder, todayStr } from "../lib";
import type { DashboardSubject, DayDetail } from "../lib";
import { useFeatures } from "../features";
import Chevron from "./Chevron";
import { LEVEL_BG, currentMonth, fmtDay, level, monthCalendar, type ViewMonth } from "./calendar";

export default function HeatmapCard({
  heat,
  oldest,
  viewMonth,
  onShiftMonth,
  pickedDay,
  detail,
  subject,
  filtered,
  onPick,
  onBack,
  trackKey,
}: {
  /** Per-day counts of the active subject (absent day = 0). */
  heat: Map<string, number>;
  /** The oldest date the heatmap window covers — the pager's lower bound. */
  oldest?: string;
  viewMonth: ViewMonth;
  onShiftMonth: (delta: number) => void;
  pickedDay: string | null;
  detail: DayDetail | null;
  subject: DashboardSubject;
  /** An axis scope filter stands — per-task rows keep their seconds, the
   *  hint's tracked-time total hides (time doesn't follow the filter). */
  filtered: boolean;
  onPick: (date: string) => void;
  onBack: () => void;
  trackKey: string;
}) {
  const features = useFeatures();
  const today = todayStr();

  const cells = useMemo(() => monthCalendar(heat, viewMonth), [heat, viewMonth]);
  const monthLabel = new Date(viewMonth.y, viewMonth.m, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
  const now = currentMonth();
  const isCurrentMonth = viewMonth.y === now.y && viewMonth.m === now.m;
  const minMonth = oldest ? monthOfDate(oldest) : now;
  const isOldestMonth = viewMonth.y === minMonth.y && viewMonth.m === minMonth.m;

  // Bring the open day detail into view.
  useEffect(() => {
    if (!pickedDay) return;
    document
      .querySelector(".an-daycard")
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [pickedDay]);

  // The detail title row, derived from the day detail itself (not the range
  // stats), so a day outside the range reads as correctly as one inside it.
  // The tracked-time total hides while an axis filter stands (time doesn't
  // follow the filter — the per-task seconds on the rows do).
  const pickedLabel =
    pickedDay == null ? "" : pickedDay === today ? "Today" : fmtDay(pickedDay);
  const pickedMissed = detail ? detail.fell.length + detail.dailyMissed.length : 0;
  const pickedSecs =
    detail && subject === "done" && features.timer && !filtered
      ? detail.tasks.reduce((s, t) => s + t.secs, 0)
      : 0;

  return (
    <section
      className={`an-card an-activity${pickedDay ? " an-daycard" : ""}`}
      key={trackKey}
    >
      {pickedDay ? (
        <div className="an-card-title">
          <span className="an-daycard-head">
            <button className="an-back" onClick={onBack} title="Back to the calendar">
              <Chevron className="left" />
            </button>
            <span className="an-daycard-day">{pickedLabel}</span>
          </span>
          <span className="hint">
            {detail != null && detail.tasks.length > 0 && (
              <span>{detail.tasks.length} {subject}</span>
            )}
            {detail != null && pickedMissed > 0 && <span>{pickedMissed} missed</span>}
            {pickedSecs > 0 && <span>{formatDuration(pickedSecs)}</span>}
          </span>
        </div>
      ) : (
        <div className="an-card-title">
          <span className="an-cal-nav">
            <button
              className="an-back"
              onClick={() => onShiftMonth(-1)}
              disabled={isOldestMonth}
              title={isOldestMonth ? "Oldest month with data" : "Previous month"}
              aria-label="Previous month"
            >
              <Chevron className="left" />
            </button>
            {monthLabel}
            <button
              className="an-back"
              onClick={() => onShiftMonth(1)}
              disabled={isCurrentMonth}
              title={isCurrentMonth ? "Current month" : "Next month"}
              aria-label="Next month"
            >
              <Chevron />
            </button>
          </span>
        </div>
      )}
      {pickedDay ? (
        <DayDetailBody detail={detail} subject={subject} features={features} />
      ) : (
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
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  disabled={c.future}
                  title={`${formatReminder(c.date)}${c.count ? ` · ${c.count} ${subject}` : ""}`}
                  onClick={() => onPick(c.date)}
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
      )}
    </section>
  );
}

/** The picked day's task-level body. Done tasks (✓, HH:MM, tracked time),
 *  what fell to Backlog (↓), missed habits (○); every row carries its axes
 *  at the right edge, gated on the Settings switches like the list itself. */
function DayDetailBody({
  detail,
  subject,
  features,
}: {
  detail: DayDetail | null;
  subject: DashboardSubject;
  features: ReturnType<typeof useFeatures>;
}) {
  return (
    <div className="an-day-detail">
      {detail == null && <div className="dd-empty">…</div>}
      {detail?.tasks.map((t) => (
        <div key={t.itemId} className={`dd-row ${subject}`}>
          <span className="dd-mark">{subject === "created" ? "+" : "✓"}</span>
          <span className="dd-time">{t.time}</span>
          <span className="dd-text">{t.text}</span>
          {subject === "done" && features.timer && t.secs > 0 && (
            <span className="dd-secs">{formatDuration(t.secs)}</span>
          )}
          {features.taskProjects && <span className="dd-proj">{t.project ?? ""}</span>}
          {features.taskPriorities && (
            <span className="dd-axis">
              {t.priority != null && <PriorityBars priority={t.priority} />}
            </span>
          )}
        </div>
      ))}
      {detail?.fell.map((f) => (
        <div key={`f-${f.time}-${f.text}`} className="dd-row fell">
          <span className="dd-mark">↓</span>
          <span className="dd-time">{f.time}</span>
          <span className="dd-text">{f.text}</span>
          {features.taskProjects && <span className="dd-proj">{f.project ?? ""}</span>}
          {features.taskPriorities && (
            <span className="dd-axis">
              {f.priority != null && <PriorityBars priority={f.priority} />}
            </span>
          )}
        </div>
      ))}
      {detail?.dailyMissed.map((m) => (
        <div key={`m-${m.text}-${m.project ?? ""}`} className="dd-row missed">
          <span className="dd-mark">○</span>
          <span className="dd-text">{m.text}</span>
          {features.taskProjects && <span className="dd-proj">{m.project ?? ""}</span>}
          {features.taskPriorities && (
            <span className="dd-axis">
              {m.priority != null && <PriorityBars priority={m.priority} />}
            </span>
          )}
        </div>
      ))}
      {detail != null &&
        detail.tasks.length === 0 &&
        detail.fell.length === 0 &&
        detail.dailyMissed.length === 0 && (
          <div className="dd-empty">Nothing that day.</div>
        )}
    </div>
  );
}

function monthOfDate(date: string): ViewMonth {
  const d = new Date(date + "T00:00:00");
  return { y: d.getFullYear(), m: d.getMonth() };
}

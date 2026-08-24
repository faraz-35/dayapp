// JournalDashboard — the synthesized summary at the top of the Journal view:
// done/missed totals for the active range, a ~6-month completion heatmap
// (click a day to jump the journal there — the same pick the date field
// makes), and project/priority splits of the range's completions. Pure
// presentation over DashboardStats; all derivation lives in
// src-tauri/src/dashboard.rs. Deliberately mouse-first — no focus-grammar
// wiring (the log below stays the keyboard surface).

import { PriorityBars } from "./ItemRow";
import { formatReminder, localDateStr, type DashboardStats } from "../lib";

/** Week columns rendered (Monday-aligned, oldest left). 27 keeps the grid
 *  inside the 480px window with room for the weekday label gutter. */
const WEEKS = 27;
const DAY_MS = 86_400_000;

type Cell = { date: string; done: number; future: boolean; isToday: boolean };

/** GitHub-style intensity: empty track, then four steps of the accent. */
const level = (done: number): number =>
  done === 0 ? 0 : done >= 7 ? 4 : done >= 4 ? 3 : done >= 2 ? 2 : 1;

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

function Stat({ value, label, accent }: { value: number; label: string; accent?: boolean }) {
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

export default function JournalDashboard({
  stats,
  activeDay,
  onPickDay,
}: {
  stats: DashboardStats;
  /** The date-jump's current value — rings the matching heatmap cell. */
  activeDay: string | null;
  onPickDay: (date: string) => void;
}) {
  const heat = new Map(stats.heatmap.map((h) => [h.date, h.done]));
  const cols = heatmapColumns(heat);
  const maxProject = Math.max(1, ...stats.projects.map((p) => p.count));
  const maxTier = Math.max(1, ...stats.priorities.map((t) => t.count));

  return (
    <div className="dash">
      <div className="dash-stats">
        <Stat value={stats.totals.done} label="Done" accent />
        <Stat value={stats.totals.dailyMissed} label="Daily missed" />
        <Stat value={stats.totals.todayMissed} label="Today missed" />
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
                activeDay === c.date ? "picked" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <button
                  key={c.date}
                  className={cls}
                  disabled={c.future}
                  title={c.future ? undefined : `${formatReminder(c.date)}${c.done ? ` · ${c.done} done` : ""}`}
                  onClick={() => onPickDay(c.date)}
                />
              );
            })}
          </div>
        </div>
      </div>

      <div className="dash-cols">
        {stats.projects.length > 0 && (
          <div className="dash-block">
            <div className="dash-h">Projects</div>
            {stats.projects.map((p) => (
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
          {stats.priorities.map((t) => (
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
    </div>
  );
}

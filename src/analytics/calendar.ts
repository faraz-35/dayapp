import { localDateStr, todayStr } from "../lib/dates";
// calendar.ts — the analytics calendar's pure helpers: the month grid, the
// intensity levels, and their shared colors. No state, no fetches — the
// HeatmapCard and the FilterBar's date popover both build grids from these.

/** A cell of the month grid: a day with its count, or a blank lead slot. */
export type HeatCell = {
  date: string;
  day: number;
  count: number;
  future: boolean;
  isToday: boolean;
};

/** A viewed month as {year, month} — month is 0-based, like Date's. */
export type ViewMonth = { y: number; m: number };

/** The month containing the app's logical today (6am→6am). */
export const currentMonth = (): ViewMonth => {
  const t = new Date(todayStr() + "T00:00:00");
  return { y: t.getFullYear(), m: t.getMonth() };
};

/** The month one step from `view` (delta ±1), rolling across years. */
export const shiftMonth = (view: ViewMonth, delta: number): ViewMonth => {
  const d = new Date(view.y, view.m + delta, 1);
  return { y: d.getFullYear(), m: d.getMonth() };
};

/** The viewed month as a Monday-first grid: `lead` blanks, then one cell
 *  per day (intensity = that day's count of the active subject). Anchored on
 *  the app's logical today (6am→6am), so a 1am session fills yesterday's
 *  cell. Trailing blanks aren't needed — the CSS grid just ends the last row
 *  short. */
export function monthCalendar(map: Map<string, number>, view: ViewMonth): (HeatCell | null)[] {
  const today = todayStr();
  const lead = (new Date(view.y, view.m, 1).getDay() + 6) % 7; // days before Monday
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const cells: (HeatCell | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const date = localDateStr(new Date(view.y, view.m, d));
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

/** The intensity level of a day's count: 0 (empty) through 4 (the accent). */
export const level = (done: number): number =>
  done === 0 ? 0 : done >= 7 ? 4 : done >= 4 ? 3 : done >= 2 ? 2 : 1;

/** The level colors as a shared scale — the calendar cells and its legend.
 *  Alphas ride --accent-rgb so every theme tints its own accent. */
export const LEVEL_BG = [
  "var(--bg-hover)",
  "rgba(var(--accent-rgb), 0.28)",
  "rgba(var(--accent-rgb), 0.5)",
  "rgba(var(--accent-rgb), 0.75)",
  "var(--accent)",
];

/** "Nov 4" — the range picker's fields and the task list's day chips. */
export const fmtDay = (d: string): string =>
  new Date(d + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });

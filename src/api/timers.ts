// Timers — per-task time tracking. A session is an interval of focused work on
// one item; exactly one may be open at a time (the single active timer).
// Sessions are measurement (content), not item-state, so they are NOT logged
// to `actions` — the journal reads them via sessionTimeByDay. See
// src-tauri/src/timers.rs.

import { invoke } from "@tauri-apps/api/core";
import type { ActiveTimer, DayTaskTime } from "../types/timer";

export const timersApi = {
  start: (itemId: string) => invoke<ActiveTimer>("start_timer", { itemId }),
  stop: () => invoke<void>("stop_timer"),
  discard: () => invoke<void>("discard_timer"),
  active: () => invoke<ActiveTimer | null>("get_active_timer"),
  /** Total seconds per item for the visible rows, including the live elapsed of
   *  the running session. Keys are item ids; absent = 0. */
  totals: (itemIds: string[]) =>
    invoke<Record<string, number>>("time_totals", { itemIds }),
  /** Today's seconds per item (the 6am→6am day) — the Daily row's ⏱: a daily
   *  habit's tracked time resets with the day, like its completion. */
  todayTotals: (itemIds: string[]) =>
    invoke<Record<string, number>>("today_totals", { itemIds }),
  sessionTimeByDay: (opts: { since?: string; until?: string } = {}) =>
    invoke<DayTaskTime[]>("session_time_by_day", {
      since: opts.since ?? null,
      until: opts.until ?? null,
    }),
};

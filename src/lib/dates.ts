// The app's logical-day helpers. The day runs 6am→6am, so "today" is the
// local date of (now − 6h) — one helper every comparison goes through,
// matching db.rs today_iso(). Change the constant, change the app's day.

import type { HideDuration } from "../types/item";

/** Today's date as ISO YYYY-MM-DD in *local* time — the pure formatter for
 *  a date you already hold. The Rust backend timestamps actions with local
 *  chrono, so rendered dates must be local too. */
export const localDateStr = (d: Date = new Date()) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

/** The hour the app's day flips: DayApp runs 6am→6am, so working past
 *  midnight is still the previous day. Matches db.rs DAY_START_HOUR. */
export const DAY_START_MS = 6 * 60 * 60 * 1000;

/** The app's "today": the local date of (now − 6h). Between midnight and
 *  6am this is yesterday — every render-time day comparison keys off it,
 *  matching db.rs today_iso(). */
export const todayStr = () => localDateStr(new Date(Date.now() - DAY_START_MS));

/** Add `days` to the app's today (negative = past), returning local ISO
 *  YYYY-MM-DD. Reminder presets and analytics ranges count logical days. */
export const todayOffset = (days: number) => {
  const d = new Date(Date.now() - DAY_START_MS);
  d.setDate(d.getDate() + days);
  return localDateStr(d);
};

/** The `hidden_until` date a hide duration maps to (local ISO YYYY-MM-DD), or
 *  null for forever. Mirrors `hidden_until_for` in db.rs — based on the
 *  app's logical today, so a hide picked late at night lasts through to the
 *  next morning's 6am boundary. Used for optimistic updates so a just-hidden
 *  row's expiry chip is right immediately, without waiting for the next
 *  refresh to reconcile. */
export const hideExpiry = (duration: HideDuration): string | null => {
  if (duration === "forever") return null;
  const d = new Date(Date.now() - DAY_START_MS);
  if (duration === "day") d.setDate(d.getDate() + 1);
  else if (duration === "week") d.setDate(d.getDate() + 7);
  else {
    // Calendar month with the day clamped to the target month's length,
    // matching chrono's checked_add_months (Jan 31 + 1 month = Feb 28/29).
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  }
  return localDateStr(d);
};

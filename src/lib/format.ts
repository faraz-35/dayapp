// Display formatters: durations, reminder chips, achieved-goal stamps. Pure —
// a value in, a display string out.

/** Compact cumulative duration: "1h 23m", "42m", "45s". */
export const formatDuration = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
};

/** Live ticking duration: H:MM:SS, or M:SS under an hour. Tabular-nums so the
 *  width stays stable as seconds roll over. */
export const formatLiveDuration = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
};

/** Format an ISO YYYY-MM-DD reminder as a short, scannable chip (→ Aug 12). */
export const formatReminder = (iso: string): string => {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/** Month-granular display for a goal's achievedAt timestamp ("Aug 2026") —
 *  goal achievements are season-scale events, not day-scale rows. */
export const formatGoalAchieved = (iso: string): string => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
};

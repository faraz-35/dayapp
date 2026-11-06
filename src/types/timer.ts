// Timer sessions: measurement (content), not item-state — never logged to
// `actions`. See src-tauri/src/timers.rs.

export interface ActiveTimer {
  itemId: string;
  itemText: string;
  startedAt: string;
}

export interface DayTaskTime {
  day: string; // YYYY-MM-DD
  itemId: string;
  itemText: string;
  seconds: number;
}

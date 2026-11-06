// The identity layer: statements of direction at three horizons — the top of
// the app's timescale stack. Like items, goals are state + logged activity
// (goal_* verbs); see src-tauri/src/goals.rs.

export const GOAL_HORIZONS = ["short", "long", "timeless"] as const;
export type GoalHorizon = (typeof GOAL_HORIZONS)[number];

export interface Goal {
  id: string;
  text: string;
  horizon: GoalHorizon;
  status: "active" | "achieved";
  projectId: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  achievedAt: string | null;
  // Soft-archive ("pause" on this surface) — same mechanism as items/notes.
  hidden: boolean;
  hiddenUntil: string | null;
}

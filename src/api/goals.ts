// Goals — the identity layer above the task sections. Like items, goals are
// state + logged activity: every create/achieve/unachieve/edit/delete appends
// to `actions` (goal_* values — see src-tauri/src/goals.rs); only the project
// link is housekeeping, unlogged.

import { invoke } from "@tauri-apps/api/core";
import type { HideDuration, HiddenFilter } from "../types/item";
import type { Goal, GoalHorizon } from "../types/goal";

export const goalsApi = {
  list: (hidden: HiddenFilter = "exclude") => invoke<Goal[]>("list_goals", { hidden }),
  create: (text: string, horizon: GoalHorizon, projectId: string | null) =>
    invoke<Goal>("create_goal", { text, horizon, projectId }),
  edit: (id: string, text: string, horizon: GoalHorizon | null) =>
    invoke<void>("edit_goal", { id, text, horizon }),
  move: (id: string, toHorizon: GoalHorizon, newIndex: number) =>
    invoke<void>("move_goal", { id, toHorizon, newIndex }),
  setProject: (id: string, projectId: string | null) =>
    invoke<void>("set_goal_project", { id, projectId }),
  achieve: (id: string) => invoke<void>("achieve_goal", { id }),
  unachieve: (id: string) => invoke<void>("unachieve_goal", { id }),
  delete: (id: string) => invoke<void>("delete_goal", { id }),
  pause: (id: string, duration: HideDuration) =>
    invoke<void>("hide_goal", { id, duration }),
  resume: (id: string) => invoke<void>("unhide_goal", { id }),
};

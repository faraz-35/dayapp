// Typed wrapper over the Tauri invoke bridge.
// Every Rust #[tauri::command] in src-tauri/src/lib.rs has a mirror here.

import { invoke } from "@tauri-apps/api/core";

export type Section = "today" | "daily" | "backlog";
export type Status = "active" | "done";

/** Hide duration. `forever` hides until manually unhidden; the rest auto-restore
 *  at the start of the named period's end date (day = tomorrow, etc.). */
export type HideDuration = "forever" | "day" | "week" | "month";

export interface Item {
  id: string;
  text: string;
  section: Section;
  status: Status;
  lastCompletedDate: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  hidden: boolean;
  hiddenUntil: string | null;
  projectId: string | null;
  remindAt: string | null;
}

export interface Action {
  id: number;
  itemId: string;
  itemText: string;
  action: string;
  fromSection?: string;
  toSection?: string;
  fromStatus?: string;
  toStatus?: string;
  timestamp: string;
}

// Rust uses serde(rename_all = "camelCase"), so the camelCase fields match.
export const api = {
  listItems: (section: Section, includeDone = false) =>
    invoke<Item[]>("list_items", { section, includeDone }),
  createItem: (text: string, section: Section) =>
    invoke<Item>("create_item", { text, section }),
  editItem: (id: string, text: string) =>
    invoke<void>("edit_item", { id, text }),
  completeItem: (id: string) => invoke<void>("complete_item", { id }),
  moveItem: (id: string, toSection: Section, newIndex: number) =>
    invoke<void>("move_item", { id, toSection, newIndex }),
  deleteItem: (id: string) => invoke<void>("delete_item", { id }),
  hideItem: (id: string, duration: HideDuration) =>
    invoke<void>("hide_item", { id, duration }),
  unhideItem: (id: string) => invoke<void>("unhide_item", { id }),
  listHiddenItems: () => invoke<Item[]>("list_hidden_items"),
  setItemProject: (id: string, projectId: string | null) =>
    invoke<void>("set_item_project", { id, projectId }),
  setReminder: (id: string, remindAt: string | null) =>
    invoke<void>("set_reminder", { id, remindAt }),
  runSweep: () => invoke<number>("run_sweep"),
  listActions: (opts: { since?: string; until?: string; limit?: number } = {}) =>
    invoke<Action[]>("list_actions", {
      limit: opts.limit ?? 500,
      since: opts.since ?? null,
      until: opts.until ?? null,
    }),
  countCompletions: (since: string) => invoke<number>("count_completions", { since }),
  selfUpdate: () => invoke<void>("self_update"),
};

export interface Project {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: string;
}

// Projects: a second organising axis alongside Sections. Assignment is
// housekeeping (not logged), mirroring the hide affordance.
export const projectsApi = {
  list: () => invoke<Project[]>("list_projects"),
  create: (name: string) => invoke<Project>("create_project", { name }),
  rename: (id: string, name: string) => invoke<void>("rename_project", { id, name }),
  delete: (id: string) => invoke<void>("delete_project", { id }),
};

/** Today's date as ISO YYYY-MM-DD in *local* time. The Rust backend timestamps
 *  actions with local chrono, so journal date ranges must be local too — the
 *  UTC-based `todayStr()` below would shift the day boundary near midnight. */
export const localDateStr = (d: Date = new Date()) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

/** Add `days` to today (negative = past), returning local ISO YYYY-MM-DD. */
export const localDateStrOffset = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localDateStr(d);
};

export const todayStr = () => new Date().toISOString().slice(0, 10);

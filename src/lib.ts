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
  runSweep: () => invoke<number>("run_sweep"),
  listActions: (limit = 500) => invoke<Action[]>("list_actions", { limit }),
  countCompletions: (since: string) => invoke<number>("count_completions", { since }),
  selfUpdate: () => invoke<void>("self_update"),
};

export const todayStr = () => new Date().toISOString().slice(0, 10);

// The items API — task rows and the `actions` log mirror. Every Rust
// #[tauri::command] has a typed mirror here (serde camelCase both ways).

import { invoke } from "@tauri-apps/api/core";
import type { Action, HideDuration, HiddenFilter, Item, Section } from "../types/item";

// Rust uses serde(rename_all = "camelCase"), so the camelCase fields match.
export const itemsApi = {
  listItems: (section: Section, includeDone = false, hidden: HiddenFilter = "exclude") =>
    invoke<Item[]>("list_items", { section, includeDone, hidden }),
  /** Project and priority ride the create call — the `created` action
   *  snapshots the row's axes at birth, so they must be on it when the log
   *  fires. */
  createItem: (text: string, section: Section, projectId?: string | null, priority?: number | null) =>
    invoke<Item>("create_item", { text, section, projectId: projectId ?? null, priority: priority ?? null }),
  editItem: (id: string, text: string) =>
    invoke<void>("edit_item", { id, text }),
  completeItem: (id: string) => invoke<void>("complete_item", { id }),
  uncompleteItem: (id: string) => invoke<void>("uncomplete_item", { id }),
  moveItem: (id: string, toSection: Section, newIndex: number) =>
    invoke<void>("move_item", { id, toSection, newIndex }),
  deleteItem: (id: string) => invoke<void>("delete_item", { id }),
  hideItem: (id: string, duration: HideDuration) =>
    invoke<void>("hide_item", { id, duration }),
  unhideItem: (id: string) => invoke<void>("unhide_item", { id }),
  setItemProject: (id: string, projectId: string | null) =>
    invoke<void>("set_item_project", { id, projectId }),
  setReminder: (id: string, remindAt: string | null) =>
    invoke<void>("set_reminder", { id, remindAt }),
  setItemPriority: (id: string, priority: 1 | 2 | 3 | null) =>
    invoke<void>("set_item_priority", { id, priority }),
  setItemAgent: (id: string, assigned: boolean) =>
    invoke<void>("set_item_agent", { id, assigned }),
  setItemDetails: (id: string, details: string) =>
    invoke<void>("set_item_details", { id, details }),
  listActions: (opts: { since?: string; until?: string; limit?: number } = {}) =>
    invoke<Action[]>("list_actions", {
      limit: opts.limit ?? 500,
      since: opts.since ?? null,
      until: opts.until ?? null,
    }),
};

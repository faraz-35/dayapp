// Notes API — separate from items. Notes are free-form content (quotes, scratch,
// paste) and live in their own table. Intentionally not entangled with item logic.

import { invoke } from "@tauri-apps/api/core";
import type { HideDuration } from "./lib";

export interface Note {
  id: string;
  body: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  hidden: boolean;
  hiddenUntil: string | null;
}

export const notesApi = {
  list: () => invoke<Note[]>("list_notes"),
  create: (body: string) => invoke<Note>("create_note", { body }),
  update: (id: string, body: string) => invoke<void>("update_note", { id, body }),
  delete: (id: string) => invoke<void>("delete_note", { id }),
  hide: (id: string, duration: HideDuration) =>
    invoke<void>("hide_note", { id, duration }),
  unhide: (id: string) => invoke<void>("unhide_note", { id }),
  listHidden: () => invoke<Note[]>("list_hidden_notes"),
};

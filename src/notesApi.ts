// Notes API — separate from items. Notes are free-form content (quotes, scratch,
// paste) and live in their own table. Intentionally not entangled with item logic.

import { invoke } from "@tauri-apps/api/core";

export interface Note {
  id: string;
  body: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export const notesApi = {
  list: () => invoke<Note[]>("list_notes"),
  create: () => invoke<Note>("create_note"),
  update: (id: string, body: string) => invoke<void>("update_note", { id, body }),
  delete: (id: string) => invoke<void>("delete_note", { id }),
};

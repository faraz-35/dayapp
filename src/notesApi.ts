// Notes API — separate from items. Notes are free-form content (quotes, scratch,
// paste) and live in their own table. Intentionally not entangled with item logic.

import { invoke } from "@tauri-apps/api/core";
import { type HideDuration, type HiddenFilter } from "./lib";

export interface Note {
  id: string;
  body: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  hidden: boolean;
  hiddenUntil: string | null;
  /** Urgency tier derived from the body's `!N` footer token (the same axis as
   *  items' priority; notes group by it Backlog-style). Not logged. */
  priority: 1 | 2 | 3 | null;
  /** Project derived from the body's `#tag` footer token — the same projects
   *  table items/goals use. Not logged. */
  projectId: string | null;
}

export const notesApi = {
  list: (hidden: HiddenFilter = "exclude") => invoke<Note[]>("list_notes", { hidden }),
  create: (body: string) => invoke<Note>("create_note", { body }),
  /** Saves the body verbatim and returns the row with its footer-derived
   *  priority/project re-derived in the same write — the caller reconciles
   *  tier grouping and labels from the return, not a refetch. */
  update: (id: string, body: string) => invoke<Note>("update_note", { id, body }),
  delete: (id: string) => invoke<void>("delete_note", { id }),
  hide: (id: string, duration: HideDuration) =>
    invoke<void>("hide_note", { id, duration }),
  unhide: (id: string) => invoke<void>("unhide_note", { id }),
  // Export a body to a .txt via the native save panel. false = user cancelled.
  saveAs: (defaultName: string, contents: string) =>
    invoke<boolean>("save_text_file", { defaultName, contents }),
};

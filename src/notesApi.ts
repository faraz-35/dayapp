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
  /** Urgency tier set via the `!N` token (same axis as items' priority; notes
   *  group by it Backlog-style). Housekeeping — not logged. */
  priority: 1 | 2 | 3 | null;
  /** Project set via the `#tag` token — the same projects table items/goals
   *  use. Housekeeping — not logged. */
  projectId: string | null;
}

export const notesApi = {
  list: (hidden: HiddenFilter = "exclude") => invoke<Note[]>("list_notes", { hidden }),
  create: (body: string) => invoke<Note>("create_note", { body }),
  update: (id: string, body: string) => invoke<void>("update_note", { id, body }),
  /** Set (or clear with null) the priority tier — the `!N` token's landing
   *  spot. Housekeeping, not logged, like items' priority. */
  setPriority: (id: string, priority: 1 | 2 | 3 | null) =>
    invoke<void>("set_note_priority", { id, priority }),
  /** Assign (or clear with null) the project — the `#tag` token's landing
   *  spot. Shares the projects table with items/goals; not logged. */
  setProject: (id: string, projectId: string | null) =>
    invoke<void>("set_note_project", { id, projectId }),
  delete: (id: string) => invoke<void>("delete_note", { id }),
  hide: (id: string, duration: HideDuration) =>
    invoke<void>("hide_note", { id, duration }),
  unhide: (id: string) => invoke<void>("unhide_note", { id }),
  // Export a body to a .txt via the native save panel. false = user cancelled.
  saveAs: (defaultName: string, contents: string) =>
    invoke<boolean>("save_text_file", { defaultName, contents }),
};

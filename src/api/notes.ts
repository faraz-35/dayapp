// The notes API — separate from items. Notes are free-form content (quotes,
// scratch, paste) and live in their own table. Intentionally not entangled
// with item logic.

import { invoke } from "@tauri-apps/api/core";
import type { HideDuration, HiddenFilter } from "../types/item";
import type { Note } from "../types/note";

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

// Entries (the ##j/##q typed capture): the notes bus's other destination —
// a leading `##j`/`##q` token routes the line to the `entries` table instead
// of creating a note. Content like notes: never logged to `actions`. See
// src-tauri/src/journal.rs.

import { invoke } from "@tauri-apps/api/core";
import type { Entry, EntryKind } from "../types/entry";

export const entriesApi = {
  list: () => invoke<Entry[]>("list_entries"),
  add: (kind: EntryKind, text: string) => invoke<Entry>("add_entry", { kind, text }),
  update: (id: string, text: string) => invoke<void>("update_entry", { id, text }),
  delete: (id: string) => invoke<void>("delete_entry", { id }),
};

// The ##j/##q typed capture: one input, a different *kind* of content —
// journal lines and quotes, stored in `entries` and displayed on their own
// pages. Content like notes: never logged to `actions`.

export type EntryKind = "journal" | "quote";

export interface Entry {
  id: string;
  kind: EntryKind;
  text: string;
  /** ISO `YYYY-MM-DD` — the local day at capture; edits never move it. */
  day: string;
  createdAt: string;
}

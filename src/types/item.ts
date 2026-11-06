// The task vocabulary: sections, statuses, and the `items` row shape shared by
// the api layer, the parsers, and every list surface. Mirrors the items table
// in src-tauri/schema.sql.

export type Section = "today" | "daily" | "backlog";
export type Status = "active" | "done";

/** Hide duration. `forever` hides until manually unhidden; the rest auto-restore
 *  at the start of the named period's end date (day = tomorrow, etc.). */
export type HideDuration = "forever" | "day" | "week" | "month";

/** How the list queries treat hidden rows — the three ⌘P visibility modes:
 *  `exclude` (regular view), `include` (Show All — hidden inline), `only`
 *  (Show Hidden Only). Mirrors `HiddenFilter` in src-tauri/src/db.rs. */
export type HiddenFilter = "exclude" | "include" | "only";

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
  priority: 1 | 2 | 3 | null;
  /** Delegation axis: true = fully delegable to an AI agent (the `@` token).
   *  Housekeeping like priority — not logged. */
  assignedToAgent: boolean;
  /** Free-form spec under the one-line title; for agent rows, the prompt an
   *  autonomous session executes. Content like notes — not logged. */
  details: string;
}

/** One row of the `actions` log — the journal every mutation writes itself. */
export interface Action {
  id: number;
  /** Set on item rows; null on goal rows (and vice versa for goalId). */
  itemId: string | null;
  goalId: string | null;
  itemText: string;
  action: string;
  fromSection?: string;
  toSection?: string;
  fromStatus?: string;
  toStatus?: string;
  timestamp: string;
}

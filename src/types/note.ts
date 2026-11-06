// Notes: free-form content (quotes, scratch, paste) in their own table.
// Content, not activity — never written to `actions`.

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

// The list pipeline's pure helpers — the Backlog's optimistic ordering, kept
// exact against the backend's SQL so optimistic updates never drift from what
// the next 60s refresh returns (see AGENTS.md "Optimistic updates").

import type { Item } from "../types/item";

// The Backlog's display order, mirroring the backend's ORDER BY (db.rs list):
// priority first (unmarked last), then manual order. Optimistic updates that
// touch priority or ordering must re-apply it — the tier dividers in
// SectionView read the rendered order, so a row left out of tier splits one
// tier group into two dividers until the next 60s refresh re-syncs. sortOrder
// is kept truthful optimistically (settleBacklogDrop), so this comparator is exact
// against what a refresh returns.
export const sortBacklog = (list: Item[]) =>
  [...list].sort(
    (a, b) =>
      (a.priority ?? 99) - (b.priority ?? 99) ||
      a.sortOrder - b.sortOrder ||
      a.createdAt.localeCompare(b.createdAt),
  );

// Re-apply the Backlog's ordering after an optimistic drop. move_item
// re-indexes sort_order 0..N across the section over the tier-sorted sequence
// with the dropped row inserted at the target index — reproduce exactly that
// indexing (and the display order it implies), so the optimistic list is what
// the next refresh returns and sortBacklog's comparator stays truthful for
// later creates/edits. `spliced` is the destination list with the moved row
// already spliced in at `fullIndex`.
export const settleBacklogDrop = (spliced: Item[], movedId: string, fullIndex: number) => {
  const moved = spliced.find((i) => i.id === movedId);
  if (!moved) return spliced;
  // The destination minus the moved row is still in its tier-sorted order
  // (the invariant above), so re-inserting at fullIndex rebuilds the same
  // sequence the backend indexes over.
  const seq = spliced.filter((i) => i.id !== movedId);
  seq.splice(Math.min(fullIndex, seq.length), 0, moved);
  return sortBacklog(seq.map((i, idx) => (i.sortOrder === idx ? i : { ...i, sortOrder: idx })));
};

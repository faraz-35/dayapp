// The custom-views model — named lenses over the display axes (Focus, Fun,
// and anything built in Settings → Views). Pure data + helpers: the store
// shape (App persists it), the seeds, and the one-line summary the settings
// rows and ⌘P entries render. A view never mutates toggles or filters — it
// composes in the same display pipelines and exiting restores everything.

import type { Project } from "../types/project";

export interface CustomView {
  id: string;
  name: string;
  // The tiers the lens keeps; a missing tier is hidden while the view is
  // active. Unmarked rows are never touched (the ⌘P tier rule).
  priorities: (1 | 2 | 3)[];
  // The delegation axis: all | agent (🤖 rows only) | mine.
  agent: "all" | "agent" | "mine";
  // The project scope: rows from ANY of these (OR within the axis); empty =
  // all projects.
  projectIds: string[];
  notes: boolean;
  notePriorities: (1 | 2 | 3)[];
  // Whether the Goals layer renders in this view.
  goals: boolean;
  // Which task sections the view keeps.
  sections: { today: boolean; daily: boolean; backlog: boolean };
}

/** Older stores kept a single `projectId` and no goals/sections — normalize
 *  on read. */
export const normalizeView = (
  v: CustomView & { projectId?: string | null },
): CustomView => ({
  ...v,
  projectIds: v.projectIds ?? (v.projectId ? [v.projectId] : []),
  goals: v.goals ?? true,
  sections: v.sections ?? { today: true, daily: true, backlog: true },
});

/** The two classic lenses, seeded as real (editable, deletable) views on
 *  first load. Their definitions are data now — edit them by recreating, or
 *  delete them and they leave ⌘P with the rest. */
export const SEED_VIEWS: CustomView[] = [
  {
    id: "view-focus", name: "Focus",
    priorities: [1], agent: "all", projectIds: [],
    notes: true, notePriorities: [1], goals: false,
    sections: { today: true, daily: true, backlog: true },
  },
  {
    id: "view-fun", name: "Fun",
    priorities: [3], agent: "all", projectIds: [],
    notes: true, notePriorities: [3], goals: true,
    sections: { today: true, daily: false, backlog: true },
  },
];

// One line on what a view shows — the row hint here and the ⌘P entry hint.
// "everything" when no axis is narrowed.
export const viewSummary = (v: CustomView, projects: Project[]): string => {
  const parts: string[] = [];
  if (v.priorities.length < 3) {
    parts.push(v.priorities.length === 0
      ? "no priorities"
      : [...v.priorities].sort().map((p) => `P${p}`).join("+"));
  }
  if (v.agent !== "all") parts.push(v.agent === "agent" ? "agent" : "mine");
  if (v.projectIds.length > 0) {
    const names = v.projectIds
      .map((id) => projects.find((p) => p.id === id)?.name ?? "project")
      .map((n) => `#${n}`);
    parts.push(names.length <= 3 ? names.join("+") : `${names.length} projects`);
  }
  if (!v.notes) parts.push("no notes");
  else if (v.notePriorities.length < 3) {
    parts.push(v.notePriorities.length === 0
      ? "no note tiers"
      : `notes ${[...v.notePriorities].sort().map((p) => `P${p}`).join("+")}`);
  }
  if (!v.goals) parts.push("no goals");
  const dropped = (["today", "daily", "backlog"] as const)
    .filter((sec) => !v.sections[sec])
    .map((sec) => `no ${sec}`);
  if (dropped.length < 3) parts.push(...dropped);
  return parts.join(" · ");
};

// The analytics page's whole data shape: the scope filter, the three subjects
// (done / created / missed), and every derived structure the backend's
// dashboard.rs returns. Pure vocabulary — no fetching here (api/analytics.ts),
// no derivation (src-tauri/src/dashboard.rs).

/** The analytics page's scope filter: which projects / priority tiers the
 *  whole dashboard derives over (stats, heatmap, splits, ledger, day detail).
 *  Each axis is null = unfiltered; a null entry *inside* a selection is the
 *  "no project" / "unmarked" bucket. OR within an axis, AND across the two.
 *  Reads the same write-time snapshots the splits do, so filtered history
 *  survives reassignment and deletion. Tracked time deliberately doesn't
 *  follow (sessions carry no axes — see dashboard.rs). */
export interface DashboardFilter {
  projects: (string | null)[] | null;
  priorities: (number | null)[] | null;
  /** The delegation axis: true = 🤖 rows only, false = Faraz's own, null =
   *  all. Not a snapshot — reads the item's current flag (see dashboard.rs). */
  agent: boolean | null;
}

/** The unfiltered scope — what the CLI and pre-filter callers see. */
export const NO_SCOPE: DashboardFilter = { projects: null, priorities: null, agent: null };

/** What the analytics page counts: effective completions (done), the tasks
 *  that entered the list (created), or the miss verdicts themselves (missed).
 *  Session-only, like the range. */
export type DashboardSubject = "done" | "created" | "missed";

export interface DayStat {
  date: string; // YYYY-MM-DD
  /** The subject's count; the done-only miss fields are 0 in created mode. */
  count: number;
  dailyMissed: number;
  todayMissed: number;
}

export interface HeatDay {
  date: string; // YYYY-MM-DD
  count: number; // nonzero — absent days are 0
}

/** One project's slice of the range's completions; `name: null` is the "no
 *  project" bucket. Current projects zero-fill so the whole roster shows. */
export interface ProjectCount {
  name: string | null;
  count: number;
}

/** One priority tier's slice; `tier: null` is the unmarked bucket. Always
 *  four rows, P1 → P3 → unmarked. */
export interface TierCount {
  tier: 1 | 2 | 3 | null;
  count: number;
}

export interface DashboardStats {
  days: DayStat[];
  heatmap: HeatDay[];
  projects: ProjectCount[];
  priorities: TierCount[];
  /** The delegation split of the range's rows (the Agent vs Mine card). */
  agents: { agent: number; mine: number };
  totals: {
    count: number;
    /** The Done lens's section split of the range's completions: daily
     * habits vs today tasks (backlog completions ride `count` only). Zero
     * under Created and Missed. */
    dailyDone: number;
    todayDone: number;
    dailyMissed: number;
    todayMissed: number;
  };
}

/** A task in the picked day's card — a completion (Done mode, with the day's
 *  tracked seconds) or a creation (Created mode); the axes are the write-time
 *  snapshots, rendered project-left / bars-right on the row. */
export interface TaskDetail {
  itemId: string;
  time: string;
  text: string;
  project: string | null;
  priority: 1 | 2 | 3 | null;
  secs: number;
}

/** A today task that fell to Backlog that day, with its axes at the fall. */
export interface FellTaskDetail {
  time: string;
  text: string;
  project: string | null;
  priority: 1 | 2 | 3 | null;
}

/** A habit the day ended without, with the axes the scope filter saw (the
 *  delegation flag is the habit's current one — assignments are unlogged). */
export interface MissedHabit {
  text: string;
  project: string | null;
  priority: 1 | 2 | 3 | null;
  agent: boolean;
}

export interface DayDetail {
  date: string;
  /** The subject's rows (Done lens: effective completions; Created lens:
   *  tasks created that day; Missed lens: empty). */
  tasks: TaskDetail[];
  fell: FellTaskDetail[];
  /** Habits the day ended without (empty for the live today; empty in created
   *  mode). */
  dailyMissed: MissedHabit[];
}

/** A row of the analytics page's paginated task list — one task's slice of
 *  the window, with its axes. `time` is HH:MM (empty for missed habits, whose
 *  verdict has no moment); `kind` is the row's mark: ✓ done, + created,
 *  ↓ fell, ○ missed. */
export interface RangeTask {
  date: string; // YYYY-MM-DD, the logical day
  time: string;
  text: string;
  project: string | null;
  priority: 1 | 2 | 3 | null;
  agent: boolean;
  kind: "done" | "created" | "fell" | "missed";
}

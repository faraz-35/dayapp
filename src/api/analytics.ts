// The analytics API — the Journal view's synthesized summary layer over
// `actions` (see src-tauri/src/dashboard.rs): the subject's counts per day
// across the range, a heatmap window, and project/priority splits. Pure
// queries over the log — the same spine as everything else. No time stats:
// sessions stay a dimension the Journal layers in, not dashboard material.

import { invoke } from "@tauri-apps/api/core";
import { NO_SCOPE } from "../types/analytics";
import type {
  DashboardFilter,
  DashboardStats,
  DashboardSubject,
  DayDetail,
  RangeTask,
} from "../types/analytics";

export const journalApi = {
  dashboard: (
    opts: { since?: string; until?: string; filter?: DashboardFilter; subject: DashboardSubject } ,
  ) =>
    invoke<DashboardStats>("journal_dashboard", {
      since: opts.since ?? null,
      until: opts.until ?? null,
      filter: opts.filter ?? null,
      subject: opts.subject,
    }),
  /** One day at task level — what the calendar card's detail renders, scoped
   *  by the same filter as the dashboard and lensed to the subject. */
  dayDetail: (date: string, subject: DashboardSubject, filter: DashboardFilter = NO_SCOPE) =>
    invoke<DayDetail>("journal_day_detail", { date, filter, subject }),
  /** The subject's tasks across the whole window, flattened newest-first —
   *  what the Tasks card paginates client-side. */
  tasks: (
    opts: { since?: string; until?: string; filter?: DashboardFilter; subject: DashboardSubject },
  ) =>
    invoke<RangeTask[]>("journal_tasks", {
      since: opts.since ?? null,
      until: opts.until ?? null,
      filter: opts.filter ?? null,
      subject: opts.subject,
    }),
};

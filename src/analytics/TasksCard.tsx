// TasksCard.tsx — the analytics page's task list: the active subject's tasks
// across the whole window, flattened newest-first by the backend's
// journal_tasks (the same derivations the dashboard runs, keeping rows), and
// paginated client-side, ten rows a page. Self-contained (the Notes pattern):
// it owns its fetch, its page state, and its reset — a fresh derivation
// (range, subject, filter) lands on page 1. The scope filter follows the
// toolbar through `filter`; tracked time stays out (the day detail owns it).

import { useEffect, useState } from "react";
import { PriorityBars } from "../components/PriorityBars";
import { useFeatures } from "../features";
import { log } from "../log";
import Chevron from "./Chevron";
import { fmtDay } from "./calendar";
import { journalApi } from "../api/analytics";
import { todayStr } from "../lib/dates";
import { DashboardFilter, DashboardSubject, RangeTask } from "../types/analytics";

/** The list's page size. */
const TASKS_PER_PAGE = 10;

/** The row's kind mark and dim class — the day-detail row language. */
const KIND_MARK: Record<RangeTask["kind"], string> = {
  done: "✓",
  created: "+",
  fell: "↓",
  missed: "○",
};

const EMPTY_TEXT: Record<DashboardSubject, string> = {
  done: "No tasks in this range.",
  created: "Nothing was created in this range.",
  missed: "Nothing was missed in this range.",
};

export default function TasksCard({
  since,
  until,
  filter,
  subject,
}: {
  since?: string;
  until?: string;
  filter: DashboardFilter;
  subject: DashboardSubject;
}) {
  const features = useFeatures();
  const [tasks, setTasks] = useState<RangeTask[] | null>(null);
  const [page, setPage] = useState(0);
  const today = todayStr();

  useEffect(() => {
    journalApi.tasks({ since, until, filter, subject })
      .then(setTasks)
      .catch((e) => log.warn("task list load failed", e));
  }, [since, until, filter, subject]);

  // A fresh derivation resets to the first page.
  useEffect(() => setPage(0), [since, until, filter, subject]);

  const pages = Math.max(1, Math.ceil((tasks?.length ?? 0) / TASKS_PER_PAGE));
  const pageIndex = Math.min(page, pages - 1);
  const visible = tasks?.slice(pageIndex * TASKS_PER_PAGE, (pageIndex + 1) * TASKS_PER_PAGE) ?? [];

  return (
    <section className="an-card an-tasks">
      <div className="an-card-title">
        Tasks
        <span className="hint">{tasks != null && tasks.length > 0 && tasks.length}</span>
      </div>
      {tasks != null && tasks.length === 0 && <div className="dash-empty">{EMPTY_TEXT[subject]}</div>}
      <div className="an-day-detail">
        {visible.map((t, i) => (
          <div key={`${i}-${t.kind}-${t.date}-${t.time}-${t.text}`} className={`dd-row rt-${t.kind}`}>
            <span className="dd-mark">{KIND_MARK[t.kind]}</span>
            <span className="dd-day">{t.date === today ? "Today" : fmtDay(t.date)}</span>
            <span className="dd-time">{t.time}</span>
            <span className="dd-text">{t.text}</span>
            {features.taskProjects && <span className="dd-proj">{t.project ?? ""}</span>}
            {features.taskPriorities && (
              <span className="dd-axis">
                {t.priority != null && <PriorityBars priority={t.priority} />}
              </span>
            )}
          </div>
        ))}
      </div>
      {pages > 1 && (
        <div className="an-pager">
          <button
            className="an-back"
            disabled={pageIndex === 0}
            onClick={() => setPage(pageIndex - 1)}
            title="Previous tasks"
            aria-label="Previous tasks"
          >
            <Chevron className="left" />
          </button>
          <span>{pageIndex + 1} / {pages}</span>
          <button
            className="an-back"
            disabled={pageIndex === pages - 1}
            onClick={() => setPage(pageIndex + 1)}
            title="More tasks"
            aria-label="More tasks"
          >
            <Chevron />
          </button>
        </div>
      )}
    </section>
  );
}

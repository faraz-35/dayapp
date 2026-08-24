// Dashboard — the Journal's synthesized summary layer: pure queries over the
// append-only log, the same "behaviour = query over timestamped state" spine
// the rest of the app runs on. Three questions per range: how much got done,
// what was missed (daily habits the day ended without, and today tasks that
// fell to Backlog unfinished — the sweep logs those for free), and where the
// work went (project + priority splits of completions). Plus a heatmap window
// of per-day completions for the trend at a glance. No time stats by design —
// sessions stay a separate dimension the Journal layers in, not dashboard
// material.
//
// History honesty: `actions.project`/`actions.priority` are snapshotted at
// write time (see log_action), so a completion reports the project and tier
// the task carried *when it was completed* — reassigning a task never
// rewrites the past. Rows written before the snapshot columns existed were
// backfilled once from then-current state (best effort, logged in migrate).
//
// "Done" is the *effective* completion set: per item per day, only items
// whose last completed/uncompleted event that day is a completion count — a
// complete→uncheck→never-again arc doesn't show as done, and a misclick
// uncheck followed by re-completing counts once, not twice. The same set
// drives every number here (day counts, heatmap, daily-done, splits), so
// nothing disagrees with anything else.

use crate::db::{today_iso, Db};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};

/// How far back the heatmap window reaches. The frontend renders 30
/// Monday-aligned week columns, so the earliest cell can sit up to 30*7−1+6
/// days behind today; 220 covers that with margin.
const HEATMAP_LOOKBACK_DAYS: i64 = 220;

/// One day's row across the requested range — the day headers' done/missed.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayStat {
    pub date: String,
    pub done: i64,
    pub daily_missed: i64,
    pub today_missed: i64,
}

/// A nonzero per-day completion count inside the heatmap window; the frontend
/// builds the ~6-month grid from these (absent day = 0).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeatDay {
    pub date: String,
    pub done: i64,
}

/// One project's slice of the range's completions. `name: None` is the "no
/// project" bucket (only present when it has completions). Current projects
/// with zero completions are included so neglected ones read as 0 — the
/// "which do I work on, with respect to the others" view.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCount {
    pub name: Option<String>,
    pub count: i64,
}

/// One priority tier's slice. `tier: None` is the unmarked bucket. Always
/// four rows, P1 → P3 → unmarked, zeros included.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TierCount {
    pub tier: Option<i64>,
    pub count: i64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub done: i64,
    pub daily_missed: i64,
    pub today_missed: i64,
    /// Consecutive days with ≥1 effective completion, counting back from
    /// today. A live today with nothing yet doesn't break it (the day isn't
    /// over); 0 when yesterday had nothing.
    pub streak: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardStats {
    pub days: Vec<DayStat>,
    pub heatmap: Vec<HeatDay>,
    pub projects: Vec<ProjectCount>,
    pub priorities: Vec<TierCount>,
    pub totals: Totals,
}

/// An item's standing on one day, folded from that day's completed/
/// uncompleted events in id order: `done` is true only when the last such
/// event is a completion. The snapshot fields ride the last completion.
#[derive(Default)]
struct Effective {
    done: bool,
    from_section: Option<String>,
    project: Option<String>,
    priority: Option<i64>,
}

impl Db {
    /// The dashboard for a half-open `[since, until)` day range (either bound
    /// optional; dates compare lexicographically against the local-RFC3339
    /// timestamps' date prefix — the same convention list_actions uses).
    pub fn journal_dashboard(
        &self, since: Option<&str>, until: Option<&str>,
    ) -> anyhow::Result<DashboardStats> {
        use chrono::NaiveDate;
        let conn = self.conn.lock().unwrap();
        let today = today_iso();
        let today_d = NaiveDate::parse_from_str(&today, "%Y-%m-%d")?;
        let heat_start = (today_d - chrono::Duration::days(HEATMAP_LOOKBACK_DAYS))
            .format("%Y-%m-%d")
            .to_string();
        let scan_end = until.unwrap_or("9999-12-31").to_string();

        // ---- Effective completions ------------------------------------------
        // day → item → standing. Scanned from the earlier of the range start
        // and the heatmap window ("" = from the beginning, so the unbounded
        // "all" range still sees full history for its splits).
        let mut done_by_day: BTreeMap<String, BTreeMap<String, Effective>> = BTreeMap::new();
        {
            let scan_start = match since {
                Some(s) => s.min(heat_start.as_str()).to_string(),
                None => String::new(),
            };
            let mut stmt = conn.prepare(
                "SELECT timestamp, item_id, action, from_section, project, priority
                 FROM actions
                 WHERE item_id IS NOT NULL AND action IN ('completed','uncompleted')
                   AND timestamp >= ?1 AND timestamp < ?2
                 ORDER BY id",
            )?;
            let rows = stmt.query_map(params![scan_start, scan_end], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<i64>>(5)?,
                ))
            })?;
            for row in rows {
                let (ts, item, action, from_section, project, priority) = row?;
                let day = ts[..10].to_string();
                let slot = done_by_day
                    .entry(day)
                    .or_default()
                    .entry(item)
                    .or_default();
                if action == "completed" {
                    slot.done = true;
                    slot.from_section = from_section;
                    slot.project = project;
                    slot.priority = priority;
                } else {
                    slot.done = false;
                }
            }
        }

        // ---- Today misses -----------------------------------------------------
        // fell_to_backlog is the sweep's own record of a today task the day
        // ended without — nothing to derive.
        let mut fell_by_day: HashMap<String, i64> = HashMap::new();
        {
            let lo = since.unwrap_or("").to_string();
            let mut stmt = conn.prepare(
                "SELECT substr(timestamp,1,10), COUNT(*) FROM actions
                 WHERE item_id IS NOT NULL AND action = 'fell_to_backlog'
                   AND timestamp >= ?1 AND timestamp < ?2
                 GROUP BY 1",
            )?;
            let rows = stmt.query_map(params![lo, scan_end], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })?;
            for row in rows {
                let (d, n) = row?;
                fell_by_day.insert(d, n);
            }
        }

        // ---- Daily-miss replay ------------------------------------------------
        // Section membership on a past day is reconstructed from the log
        // itself (created/moved/fell/deleted), so habits deleted long ago
        // still count for the days they existed. Currently hidden items are
        // excluded throughout — hide is unlogged, so "currently" is the best
        // the log can say, and an archived habit must not accrue misses
        // forever.
        struct Ev {
            ts: String,
            item: String,
            action: String,
            to_section: Option<String>,
        }
        let mut events: Vec<Ev> = Vec::new();
        {
            let mut stmt = conn.prepare(
                "SELECT timestamp, item_id, action, to_section FROM actions
                 WHERE item_id IS NOT NULL
                   AND action IN ('created','moved','fell_to_backlog','deleted')
                 ORDER BY timestamp, id",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(Ev {
                    ts: r.get(0)?,
                    item: r.get(1)?,
                    action: r.get(2)?,
                    to_section: r.get(3)?,
                })
            })?;
            for row in rows {
                events.push(row?);
            }
        }
        let hidden: HashSet<String> = {
            let mut stmt = conn.prepare("SELECT id FROM items WHERE hidden = 1")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.filter_map(|r| r.ok()).collect()
        };

        // The range's day span: honor `since` exactly when given; unbounded
        // starts at the log's first item action. The last day is
        // min(until − 1, today) — `until` is exclusive and the future hasn't
        // been logged yet.
        let first_day: Option<String> = conn
            .query_row(
                "SELECT MIN(substr(timestamp,1,10)) FROM actions WHERE item_id IS NOT NULL",
                [], |r| r.get(0),
            )
            .optional()?;
        let start_d = NaiveDate::parse_from_str(
            since.or(first_day.as_deref()).unwrap_or(&today),
            "%Y-%m-%d",
        )?;
        let end_d = match until {
            Some(u) => NaiveDate::parse_from_str(u, "%Y-%m-%d")?
                .pred_opt()
                .unwrap_or(today_d)
                .min(today_d),
            None => today_d,
        };

        let mut days: Vec<DayStat> = Vec::new();
        let mut totals = Totals::default();
        let mut idx = 0usize;        // item → (alive, section) as of the day being processed.
        let mut live: HashMap<String, (bool, Option<String>)> = HashMap::new();
        let mut d = start_d;
        while d <= end_d {
            let day = d.format("%Y-%m-%d").to_string();
            let day_end = format!("{day}T23:59:59");
            while idx < events.len() && events[idx].ts <= day_end {
                let ev = &events[idx];
                let slot = live.entry(ev.item.clone()).or_insert((false, None));
                match ev.action.as_str() {
                    "created" => *slot = (true, ev.to_section.clone()),
                    "moved" | "fell_to_backlog" => slot.1 = ev.to_section.clone(),
                    "deleted" => slot.0 = false,
                    _ => {}
                }
                idx += 1;
            }

            let done_map = done_by_day.get(&day);
            let done = done_map.map_or(0, |m| m.values().filter(|e| e.done).count()) as i64;

            // The current day's habits aren't "missed" — the day is still
            // live; misses are a day-end verdict.
            let mut daily_missed = 0i64;
            if day != today {
                let done_daily: HashSet<&String> = done_map.map_or_else(HashSet::new, |m| {
                    m.iter()
                        .filter(|(_, e)| e.done && e.from_section.as_deref() == Some("daily"))
                        .map(|(id, _)| id)
                        .collect()
                });
                daily_missed = live
                    .iter()
                    .filter(|(id, (alive, sec))| {
                        *alive
                            && sec.as_deref() == Some("daily")
                            && !hidden.contains(*id)
                            && !done_daily.contains(id)
                    })
                    .count() as i64;
            }
            let today_missed = fell_by_day.get(&day).copied().unwrap_or(0);

            totals.done += done;
            totals.daily_missed += daily_missed;
            totals.today_missed += today_missed;
            days.push(DayStat { date: day, done, daily_missed, today_missed });
            d += chrono::Duration::days(1);
        }

        // Current streak: consecutive days with ≥1 effective completion,
        // walking back from today. A zero today is skipped (the day is still
        // live), but every earlier day must have one. The scan window is at
        // least the heatmap's ~7 months, which bounds any realistic streak.
        let has_done = |d: NaiveDate| -> bool {
            let day = d.format("%Y-%m-%d").to_string();
            done_by_day.get(&day).map_or(false, |m| m.values().any(|e| e.done))
        };
        {
            let mut d = today_d;
            if !has_done(d) {
                d -= chrono::Duration::days(1); // today still live — don't break it
            }
            while has_done(d) {
                totals.streak += 1;
                d -= chrono::Duration::days(1);
            }
        }

        // ---- Heatmap window ----------------------------------------------------
        let heatmap: Vec<HeatDay> = done_by_day
            .range(heat_start..=today)
            .filter(|(_, m)| m.values().any(|e| e.done))
            .map(|(day, m)| HeatDay {
                date: day.clone(),
                done: m.values().filter(|e| e.done).count() as i64,
            })
            .collect();

        // ---- Project / priority splits (range days only) -----------------------
        let range_start = start_d.format("%Y-%m-%d").to_string();
        let range_end = end_d.format("%Y-%m-%d").to_string();
        let mut proj_counts: HashMap<Option<String>, i64> = HashMap::new();
        let mut tier_counts: HashMap<Option<i64>, i64> = HashMap::new();
        for (day, m) in &done_by_day {
            if day.as_str() < range_start.as_str() || day.as_str() > range_end.as_str() {
                continue;
            }
            for e in m.values() {
                if !e.done {
                    continue;
                }
                *proj_counts.entry(e.project.clone()).or_insert(0) += 1;
                *tier_counts.entry(e.priority).or_insert(0) += 1;
            }
        }
        // Zero-fill from the current projects so the split shows the whole
        // roster, not just the ones that scored.
        {
            let mut stmt = conn.prepare("SELECT name FROM projects")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            for row in rows {
                if let Ok(name) = row {
                    proj_counts.entry(Some(name)).or_insert(0);
                }
            }
        }
        let none_count = proj_counts.get(&None).copied().unwrap_or(0);
        let mut projects: Vec<ProjectCount> = proj_counts
            .into_iter()
            .filter_map(|(name, count)| name.map(|n| ProjectCount { name: Some(n), count }))
            .collect();
        projects.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));
        if none_count > 0 {
            projects.push(ProjectCount { name: None, count: none_count });
        }

        let tier = |t: Option<i64>| tier_counts.get(&t).copied().unwrap_or(0);
        let priorities = vec![
            TierCount { tier: Some(1), count: tier(Some(1)) },
            TierCount { tier: Some(2), count: tier(Some(2)) },
            TierCount { tier: Some(3), count: tier(Some(3)) },
            TierCount { tier: None, count: tier(None) },
        ];

        Ok(DashboardStats { days, heatmap, projects, priorities, totals })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_db() -> (Db, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("dayapp-dash-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        (Db::open(&path).unwrap(), dir)
    }

    /// Craft an action row directly — backdated history for the replay. The
    /// write-time snapshot columns are settable so split queries can be
    /// exercised without live rows.
    #[allow(clippy::too_many_arguments)]
    fn act(
        conn: &rusqlite::Connection, item: &str, action: &str,
        from_section: Option<&str>, to_section: Option<&str>,
        project: Option<&str>, priority: Option<i64>, ts: &str,
    ) {
        conn.execute(
            "INSERT INTO actions (item_id,item_text,action,from_section,to_section,timestamp,project,priority)
             VALUES (?1,?1,?2,?3,?4,?5,?6,?7)",
            params![item, action, from_section, to_section, ts, project, priority],
        )
        .unwrap();
    }

    fn by_date(s: &DashboardStats) -> HashMap<&str, &DayStat> {
        s.days.iter().map(|d| (d.date.as_str(), d)).collect()
    }

    #[test]
    fn daily_and_today_misses_replay_from_the_log() {
        let (db, dir) = tmp_db();
        {
            let conn = db.conn.lock().unwrap();
            // Two habits from Jan 1; B skips Jan 3 and Jan 5.
            act(&conn, "A", "created", None, Some("daily"), None, None, "2026-01-01T09:00:00");
            act(&conn, "B", "created", None, Some("daily"), None, None, "2026-01-01T09:00:00");
            for (day, who) in [
                ("02", "A"), ("02", "B"), ("03", "A"),
                ("04", "A"), ("04", "B"), ("05", "A"),
            ] {
                act(&conn, who, "completed", Some("daily"), Some("daily"), None, None,
                    &format!("2026-01-{day}T10:00:00"));
            }
            // A today task that never happened on Jan 3 — the sweep's record.
            act(&conn, "C", "created", None, Some("today"), None, None, "2026-01-02T09:00:00");
            act(&conn, "C", "fell_to_backlog", Some("today"), Some("backlog"), None, None,
                "2026-01-03T00:01:00");
        }
        let s = db.journal_dashboard(Some("2026-01-02"), Some("2026-01-06")).unwrap();
        let by = by_date(&s);
        assert_eq!(by["2026-01-02"].done, 2);
        assert_eq!(by["2026-01-02"].daily_missed, 0);
        assert_eq!(by["2026-01-03"].done, 1);
        assert_eq!(by["2026-01-03"].daily_missed, 1); // B skipped
        assert_eq!(by["2026-01-03"].today_missed, 1); // C fell
        assert_eq!(by["2026-01-04"].daily_missed, 0);
        assert_eq!(by["2026-01-05"].daily_missed, 1);
        assert_eq!(s.totals.done, 6);
        assert_eq!(s.totals.daily_missed, 2);
        assert_eq!(s.totals.today_missed, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unchecked_tasks_dont_count_and_splits_read_snapshots() {
        let (db, dir) = tmp_db();
        {
            let conn = db.conn.lock().unwrap();
            act(&conn, "D", "created", None, Some("today"), None, None, "2026-01-01T09:00:00");
            // complete → uncheck → complete again: counts once, not twice.
            act(&conn, "D", "completed", Some("today"), Some("today"), Some("meridian"), Some(1),
                "2026-01-02T10:00:00");
            act(&conn, "D", "uncompleted", Some("today"), Some("today"), None, None,
                "2026-01-02T11:00:00");
            act(&conn, "D", "completed", Some("today"), Some("today"), Some("meridian"), Some(1),
                "2026-01-02T12:00:00");
            // E completed and left alone.
            act(&conn, "E", "created", None, Some("backlog"), None, None, "2026-01-01T09:00:00");
            act(&conn, "E", "completed", Some("backlog"), Some("backlog"), None, None,
                "2026-01-02T13:00:00");
            // F completed then unchecked and never re-done — not done.
            act(&conn, "F", "created", None, Some("today"), None, None, "2026-01-01T09:00:00");
            act(&conn, "F", "completed", Some("today"), Some("today"), Some("growth"), None,
                "2026-01-02T14:00:00");
            act(&conn, "F", "uncompleted", Some("today"), Some("today"), None, None,
                "2026-01-02T15:00:00");
        }
        let s = db.journal_dashboard(Some("2026-01-02"), Some("2026-01-03")).unwrap();
        assert_eq!(s.days[0].done, 2); // D once + E; F's completion was undone
        // Splits read the snapshot columns of the effective completions only
        // (F's undone completion contributes nothing, and no live projects
        // exist to zero-fill).
        let names: Vec<(Option<&str>, i64)> =
            s.projects.iter().map(|p| (p.name.as_deref(), p.count)).collect();
        assert_eq!(names, [(Some("meridian"), 1), (None, 1)]);
        let tiers: Vec<(Option<i64>, i64)> =
            s.priorities.iter().map(|t| (t.tier, t.count)).collect();
        assert_eq!(tiers, [(Some(1), 1), (Some(2), 0), (Some(3), 0), (None, 1)]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn completions_and_deletions_snapshot_project_and_priority() {
        let (db, dir) = tmp_db();
        let p = db.create_project("meridian").unwrap();
        let i = db.create_item("ship it", "today").unwrap();
        db.set_item_project(&i.id, Some(&p.id)).unwrap();
        db.set_item_priority(&i.id, Some(2)).unwrap();
        db.complete_item(&i.id).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            let (proj, prio): (Option<String>, Option<i64>) = conn
                .query_row(
                    "SELECT project, priority FROM actions WHERE action = 'completed'",
                    [], |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(proj.as_deref(), Some("meridian"));
            assert_eq!(prio, Some(2));
        }
        // The delete still snapshots — delete_item logs before the row goes.
        db.delete_item(&i.id).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            let proj: Option<String> = conn
                .query_row(
                    "SELECT project FROM actions WHERE action = 'deleted'",
                    [], |r| r.get(0),
                )
                .unwrap();
            assert_eq!(proj.as_deref(), Some("meridian"));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn streak_tolerates_a_live_today() {
        let (db, dir) = tmp_db();
        let today = chrono::Local::now().date_naive();
        let day = |back: i64| (today - chrono::Duration::days(back)).format("%Y-%m-%d").to_string();
        {
            let conn = db.conn.lock().unwrap();
            // Done yesterday and the two days before; today still empty.
            for back in [1, 2, 3] {
                act(&conn, "S", "completed", Some("today"), Some("today"), None, None,
                    &format!("{}T09:00:00", day(back)));
            }
        }
        let s = db.journal_dashboard(None, None).unwrap();
        assert_eq!(s.totals.streak, 3, "an empty live today must not break the streak");
        {
            let conn = db.conn.lock().unwrap();
            act(&conn, "S", "completed", Some("today"), Some("today"), None, None,
                &format!("{}T10:00:00", day(0)));
        }
        let s = db.journal_dashboard(None, None).unwrap();
        assert_eq!(s.totals.streak, 4);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hidden_habits_dont_accrue_misses() {
        let (db, dir) = tmp_db();
        let a = db.create_item("habit a", "daily").unwrap();
        let b = db.create_item("habit b", "daily").unwrap();
        db.hide_item(&b.id, "forever").unwrap();
        db.complete_item(&a.id).unwrap();
        {
            // Backdate: both habits existed from Jan 1, A completed Jan 2.
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE actions SET timestamp = '2026-01-01T09:00:00' WHERE action = 'created'",
                [],
            )
            .unwrap();
            conn.execute(
                "UPDATE actions SET timestamp = '2026-01-02T10:00:00' WHERE action = 'completed'",
                [],
            )
            .unwrap();
        }
        let s = db.journal_dashboard(Some("2026-01-02"), Some("2026-01-03")).unwrap();
        // B is hidden → outside the population → 0 missed (1 if it counted).
        assert_eq!(s.days[0].daily_missed, 0);
        assert_eq!(s.days[0].done, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

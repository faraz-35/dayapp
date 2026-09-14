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
//
// Two subjects share every shape: Done (the set above, with the miss
// verdicts) and Created — the tasks that entered the list, one `created`
// action each, nothing to fold. The GUI's toggle swaps what every surface
// counts; under Created the done-only verdicts (streak, both misses) stay
// zero and the frontend hides their cards.

use crate::db::{day_key_of_ts, day_start_prefix, today_iso, Db};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

/// How far back the heatmap window reaches. The frontend renders 52
/// Monday-aligned week columns on wide windows (30 on the 480px one), so the
/// earliest cell can sit up to 52*7−1+6 days behind today; 380 covers that
/// with margin.
const HEATMAP_LOOKBACK_DAYS: i64 = 380;

// ---- The scope filter -------------------------------------------------------
//
// The analytics page's axis filters: which projects / priority tiers the whole
// dashboard derives over — stats, heatmap, splits, ledger, and day detail.
// OR within an axis, AND across the two. Everything reads the write-time
// snapshots, so filtered history stays deletion-proof. Two deliberate edges:
// tracked time does NOT follow the filter (sessions carry no axes — Faraz's
// call, 2026-08-25, the timer is barely used), and the daily-miss replay keys
// habits' population off their CURRENT axes (assignments are unlogged —
// "currently" is the best the log can say) while their done-check reads the
// unfiltered completion set, so a habit reassigned mid-history never reads as
// a phantom miss.
/// The IPC shape: each axis is None (unfiltered) or a selection of values,
/// where a None *inside* the selection is the "no project" / "unmarked"
/// bucket. The empty selection (Some(vec![])) matches nothing.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScopeFilter {
    pub projects: Option<Vec<Option<String>>>,
    pub priorities: Option<Vec<Option<i64>>>,
}

/// The filter normalized for matching: each axis is None = allow all, or the
/// exact allowed set (None inside = the unmarked bucket).
#[derive(Debug, Clone, Default)]
pub struct Scope {
    projects: Option<HashSet<Option<String>>>,
    priorities: Option<HashSet<Option<i64>>>,
}

impl ScopeFilter {
    pub fn scope(&self) -> Scope {
        Scope {
            projects: self.projects.as_ref().map(|v| v.iter().cloned().collect()),
            priorities: self.priorities.as_ref().map(|v| v.iter().cloned().collect()),
        }
    }
}

impl Scope {
    /// Both axes at once (AND across, OR within) — the row-level test for
    /// folds done in Rust.
    fn allows(&self, project: &Option<String>, priority: &Option<i64>) -> bool {
        self.allows_project(project) && self.allows_priority(priority)
    }

    fn allows_project(&self, p: &Option<String>) -> bool {
        self.projects.as_ref().map_or(true, |s| s.contains(p))
    }

    fn allows_priority(&self, p: &Option<i64>) -> bool {
        self.priorities.as_ref().map_or(true, |s| s.contains(p))
    }

    fn is_empty(&self) -> bool {
        self.projects.is_none() && self.priorities.is_none()
    }

    /// The SQL half of the filter: predicates over the `project`/`priority`
    /// snapshot columns, appended to a dynamically built query (fell counts,
    /// sessions). Unfiltered axes append nothing, so unfiltered queries are
    /// byte-identical to what they were before the filter existed.
    pub fn push_sql(
        &self,
        sql: &mut String,
        pv: &mut Vec<Box<dyn rusqlite::ToSql>>,
    ) {
        push_axis_pred("project", self.projects.as_ref(), sql, pv);
        push_axis_pred("priority", self.priorities.as_ref(), sql, pv);
    }
}

/// One axis's predicate: `col IN (…)` (plus `OR col IS NULL` when the
/// selection includes the unmarked bucket; bare `col IS NULL` when it's the
/// only member). Nothing appended when the axis is unfiltered.
fn push_axis_pred<T: rusqlite::ToSql + Clone + Eq + std::hash::Hash + 'static>(
    col: &str,
    sel: Option<&HashSet<Option<T>>>,
    sql: &mut String,
    pv: &mut Vec<Box<dyn rusqlite::ToSql>>,
) {
    let Some(set) = sel else { return };
    if set.is_empty() {
        sql.push_str(" AND 0"); // an empty selection matches nothing
        return;
    }
    let somes: Vec<&T> = set.iter().filter_map(|v| v.as_ref()).collect();
    if somes.is_empty() {
        sql.push_str(&format!(" AND {col} IS NULL"));
        return;
    }
    let marks = vec!["?"; somes.len()].join(",");
    if set.contains(&None) {
        sql.push_str(&format!(" AND ({col} IN ({marks}) OR {col} IS NULL)"));
    } else {
        sql.push_str(&format!(" AND {col} IN ({marks})"));
    }
    for v in somes {
        pv.push(Box::new((*v).clone()));
    }
}

/// What the dashboard counts. Done is the effective completion set with the
/// miss verdicts; Created is the tasks that entered the list. The toggle is
/// display-only — same shapes, same scope filter (creations snapshot their
/// axes at birth like every action).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Subject {
    Done,
    Created,
}

/// One day's row across the requested range — the subject's count, plus the
/// done-only miss verdicts (zero under Created).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayStat {
    pub date: String,
    pub count: i64,
    pub daily_missed: i64,
    pub today_missed: i64,
}

/// A nonzero per-day count inside the heatmap window; the frontend
/// builds the ~6-month grid from these (absent day = 0).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeatDay {
    pub date: String,
    pub count: i64,
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
    pub count: i64,
    pub daily_missed: i64,
    pub today_missed: i64,
    /// Consecutive days with ≥1 effective completion, counting back from
    /// today. A live today with nothing yet doesn't break it (the day isn't
    /// over); 0 when yesterday had nothing. Done-only — always 0 under
    /// Created.
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

/// One task in a day's expanded detail — the subject's row (a completion
/// under Done, a creation under Created). `secs` starts at 0 here; the
/// command wrapper layers the day's session time per item on top in Done
/// mode (sessions are a separate dimension).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDetail {
    pub item_id: String,
    /// HH:MM of the event (the effective completion, or the creation).
    pub time: String,
    pub text: String,
    pub project: Option<String>,
    pub priority: Option<i64>,
    pub secs: i64,
}

/// A today task that fell to Backlog that day — the sweep's own record.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FellTaskDetail {
    pub time: String,
    pub text: String,
}

/// A single day at task level — what clicking a day on the analytics page
/// expands to: the subject's rows (`tasks` — effective completions under
/// Done, creations under Created), plus the done-only fell/missed lists
/// (empty under Created).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayDetail {
    pub date: String,
    pub tasks: Vec<TaskDetail>,
    pub fell: Vec<FellTaskDetail>,
    /// Texts of habits the day ended without (empty for the live today).
    pub daily_missed: Vec<String>,
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

// ---- The daily-miss replay -------------------------------------------------
//
// Section membership on a past day is reconstructed from the log itself
// (created/moved/fell/deleted), so habits deleted long ago still count for
// the days they existed. Pauses fold the same way (paused/unpaused actions —
// the dated record of a hide): a habit paused on a day was never expected
// that day, while the days before the pause keep their verdicts. Shared by
// the range replay in journal_dashboard and the single-day day_detail.

/// An item's standing in the replay: alive + current section, whether the
/// day being processed falls inside a logged pause, plus the latest text
/// snapshot (for naming missed habits whose row is long gone) and the latest
/// axes snapshot (the scope filter's fallback for deleted rows).
#[derive(Default, Clone)]
struct LiveItem {
    alive: bool,
    section: Option<String>,
    paused: bool,
    text: String,
    project: Option<String>,
    priority: Option<i64>,
}

struct LifeEv {
    ts: String,
    item: String,
    action: String,
    to_section: Option<String>,
    text: String,
    project: Option<String>,
    priority: Option<i64>,
}

fn fetch_life_events(conn: &rusqlite::Connection) -> anyhow::Result<Vec<LifeEv>> {
    let mut stmt = conn.prepare(
        "SELECT timestamp, item_id, action, to_section, item_text, project, priority
         FROM actions
         WHERE item_id IS NOT NULL
           AND action IN ('created','moved','fell_to_backlog','deleted','paused','unpaused')
         ORDER BY timestamp, id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(LifeEv {
            ts: r.get(0)?,
            item: r.get(1)?,
            action: r.get(2)?,
            to_section: r.get(3)?,
            text: r.get(4)?,
            project: r.get(5)?,
            priority: r.get(6)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Current items' axes (project name + priority), for the daily-miss replay's
/// population under a scope filter. Assignments are unlogged, so "currently"
/// is the best the log can say. Deleted habits fall back to their folded
/// life-event snapshots.
fn fetch_item_axes(
    conn: &rusqlite::Connection,
) -> anyhow::Result<HashMap<String, (Option<String>, Option<i64>)>> {
    let mut stmt = conn.prepare(
        "SELECT i.id, p.name, i.priority
         FROM items i LEFT JOIN projects p ON p.id = i.project_id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<i64>>(2)?))
    })?;
    let mut out = HashMap::new();
    for row in rows {
        let (id, project, priority) = row?;
        out.insert(id, (project, priority));
    }
    Ok(out)
}

/// Fold one lifecycle event into the live map. Events arrive oldest-first;
/// the map holds each item's standing as of the last event applied.
fn apply_life_event(live: &mut HashMap<String, LiveItem>, ev: &LifeEv) {
    let slot = live.entry(ev.item.clone()).or_default();
    match ev.action.as_str() {
        "created" => {
            slot.alive = true;
            slot.section = ev.to_section.clone();
            slot.text = ev.text.clone();
            slot.project = ev.project.clone();
            slot.priority = ev.priority;
        }
        "moved" | "fell_to_backlog" => {
            slot.section = ev.to_section.clone();
            slot.text = ev.text.clone();
            slot.project = ev.project.clone();
            slot.priority = ev.priority;
        }
        "paused" => slot.paused = true,
        "unpaused" => slot.paused = false,
        "deleted" => slot.alive = false,
        _ => {}
    }
}

/// The day's missed-habit texts: alive daily items not inside a logged pause
/// whose day ended without a daily completion. Under a scope filter, only
/// habits whose axes match are in the population — a habit outside the filter
/// is neither expected nor missed. Axes come from the live row when it still
/// exists, else the folded life-event snapshot.
fn daily_missed_texts(
    live: &HashMap<String, LiveItem>,
    done_daily: &HashSet<String>,
    axes: &HashMap<String, (Option<String>, Option<i64>)>,
    scope: &Scope,
) -> Vec<String> {
    live.iter()
        .filter(|(id, it)| {
            let (project, priority) = axes
                .get(id.as_str())
                .cloned()
                .unwrap_or((it.project.clone(), it.priority));
            it.alive
                && it.section.as_deref() == Some("daily")
                && !it.paused
                && !done_daily.contains(id.as_str())
                && scope.allows(&project, &priority)
        })
        .map(|(_, it)| it.text.clone())
        .collect()
}

/// The ISO day after `date` — the exclusive upper bound for a single-day scan.
pub fn next_day(date: &str) -> anyhow::Result<String> {
    use chrono::NaiveDate;
    let d = NaiveDate::parse_from_str(date, "%Y-%m-%d")?;
    Ok((d + chrono::Duration::days(1)).format("%Y-%m-%d").to_string())
}

/// The range's day span: honor `since` exactly when given; unbounded starts
/// at the log's first item action. The last day is min(until − 1, today) —
/// `until` is exclusive and the future hasn't been logged yet.
fn day_span(
    conn: &rusqlite::Connection, since: Option<&str>, until: Option<&str>, today_d: chrono::NaiveDate,
) -> anyhow::Result<(chrono::NaiveDate, chrono::NaiveDate)> {
    use chrono::NaiveDate;
    let first_day: Option<String> = conn
        .query_row(
            "SELECT MIN(timestamp) FROM actions WHERE item_id IS NOT NULL",
            [], |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
        .and_then(|ts| day_key_of_ts(&ts));
    let start = NaiveDate::parse_from_str(
        since.or(first_day.as_deref()).unwrap_or(&today_iso()),
        "%Y-%m-%d",
    )?;
    let end = match until {
        Some(u) => NaiveDate::parse_from_str(u, "%Y-%m-%d")?.pred_opt().unwrap_or(today_d).min(today_d),
        None => today_d,
    };
    Ok((start, end))
}

/// The heatmap window: the nonzero per-day counts inside `[heat_start, today]`.
fn heat_days(per_day: &BTreeMap<String, i64>, heat_start: &str, today: &str) -> Vec<HeatDay> {
    per_day
        .range(heat_start.to_string()..=today.to_string())
        .filter(|(_, &count)| count > 0)
        .map(|(date, &count)| HeatDay { date: date.clone(), count })
        .collect()
}

/// The projects split assembly: zero-fill from the current roster so the
/// split shows the whole roster (neglected ones read as 0), sort by count
/// desc, and a trailing "none" bucket when unprojected work exists.
fn finish_projects(
    conn: &rusqlite::Connection, mut proj_counts: HashMap<Option<String>, i64>,
) -> anyhow::Result<Vec<ProjectCount>> {
    let mut stmt = conn.prepare("SELECT name FROM projects")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    for row in rows {
        if let Ok(name) = row {
            proj_counts.entry(Some(name)).or_insert(0);
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
    Ok(projects)
}

/// The priority split assembly: always four rows, P1 → P3 → unmarked.
fn finish_priorities(tier_counts: HashMap<Option<i64>, i64>) -> Vec<TierCount> {
    let tier = |t: Option<i64>| tier_counts.get(&t).copied().unwrap_or(0);
    vec![
        TierCount { tier: Some(1), count: tier(Some(1)) },
        TierCount { tier: Some(2), count: tier(Some(2)) },
        TierCount { tier: Some(3), count: tier(Some(3)) },
        TierCount { tier: None, count: tier(None) },
    ]
}

impl Db {
    /// The dashboard for a subject — Done (effective completions, with the
    /// miss verdicts) or Created (the tasks that entered the list).
    /// `since`/`until` are a half-open logical-day range (either bound
    /// optional; bounds translate to `T06:00:00` wall-clock prefixes — the
    /// same convention list_actions uses — and every action keys to its day
    /// via `day_key_of_ts`). `filter` scopes every number to the selected
    /// projects/tiers (see the scope-filter block above).
    pub fn journal_dashboard(
        &self, since: Option<&str>, until: Option<&str>, filter: &ScopeFilter, subject: Subject,
    ) -> anyhow::Result<DashboardStats> {
        match subject {
            Subject::Done => self.done_dashboard(since, until, filter),
            Subject::Created => self.created_dashboard(since, until, filter),
        }
    }

    /// The Done dashboard: the effective-completion fold drives every number
    /// (day counts, heatmap, streak, splits); the two miss replays ride the
    /// same walk.
    fn done_dashboard(
        &self, since: Option<&str>, until: Option<&str>, filter: &ScopeFilter,
    ) -> anyhow::Result<DashboardStats> {
        use chrono::NaiveDate;
        let scope = filter.scope();
        let conn = self.conn.lock().unwrap();
        let today = today_iso();
        let today_d = NaiveDate::parse_from_str(&today, "%Y-%m-%d")?;
        let heat_start = (today_d - chrono::Duration::days(HEATMAP_LOOKBACK_DAYS))
            .format("%Y-%m-%d")
            .to_string();
        let scan_end = day_start_prefix(until.unwrap_or("9999-12-31"));

        // ---- Effective completions ------------------------------------------
        // day → item → standing, folded twice: the scoped fold drives every
        // number on the page (day counts, heatmap, streak, splits), the
        // unscoped fold is the miss replay's done-check (a habit completed
        // that day is done, whatever axes the completion carried — the
        // habit's own axes decide whether it's in the population). Scanned
        // from the earlier of the range start and the heatmap window ("" =
        // from the beginning, so the unbounded "all" range still sees full
        // history for its splits).
        let mut done_by_day: BTreeMap<String, BTreeMap<String, Effective>> = BTreeMap::new();
        let mut done_all_by_day: BTreeMap<String, BTreeMap<String, Effective>> = BTreeMap::new();
        {
            // The scan window: the earlier of the range start and the heatmap
            // window, as a wall-clock bound ("" = from the beginning, so the
            // unbounded "all" range still sees full history for its splits).
            let scan_start = match since {
                Some(s) => s.min(heat_start.as_str()).to_string(),
                None => String::new(),
            };
            let scan_lo = if scan_start.is_empty() { scan_start } else { day_start_prefix(&scan_start) };
            let mut stmt = conn.prepare(
                "SELECT timestamp, item_id, action, from_section, project, priority
                 FROM actions
                 WHERE item_id IS NOT NULL AND action IN ('completed','uncompleted')
                   AND timestamp >= ?1 AND timestamp < ?2
                 ORDER BY id",
            )?;
            let rows = stmt.query_map(params![scan_lo, scan_end], |r| {
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
                let Some(day) = day_key_of_ts(&ts) else { continue };
                let slot = done_all_by_day
                    .entry(day.clone())
                    .or_default()
                    .entry(item.clone())
                    .or_default();
                if action == "completed" {
                    slot.done = true;
                    slot.from_section = from_section.clone();
                    slot.project = project.clone();
                    slot.priority = priority;
                } else {
                    slot.done = false;
                }
                // The scoped fold: only completions whose snapshot axes match
                // enter; uncompletions always flip any existing entry false,
                // so the effective (last-event-wins) semantics survive.
                if action == "completed" {
                    if scope.allows(&project, &priority) {
                        let slot = done_by_day
                            .entry(day)
                            .or_default()
                            .entry(item)
                            .or_default();
                        slot.done = true;
                        slot.from_section = from_section;
                        slot.project = project;
                        slot.priority = priority;
                    }
                } else {
                    let slot = done_by_day
                        .entry(day)
                        .or_default()
                        .entry(item)
                        .or_default();
                    slot.done = false;
                }
            }
        }

        // ---- Today misses -----------------------------------------------------
        // fell_to_backlog is the sweep's own record of a today task the day
        // ended without — nothing to derive. Scoped by the snapshot axes.
        let mut fell_by_day: HashMap<String, i64> = HashMap::new();
        {
            // Counted in Rust: the logical day key shifts the wall-clock date
            // back past the 6am boundary, which SQL can't express over the
            // text timestamps.
            let lo = since.map(day_start_prefix).unwrap_or_default();
            let mut sql = String::from(
                "SELECT timestamp FROM actions
                 WHERE item_id IS NOT NULL AND action = 'fell_to_backlog'
                   AND timestamp >= ? AND timestamp < ?",
            );
            let mut pv: Vec<Box<dyn rusqlite::ToSql>> =
                vec![Box::new(lo), Box::new(scan_end)];
            scope.push_sql(&mut sql, &mut pv);
            let refs: Vec<&dyn rusqlite::ToSql> = pv.iter().map(|p| p.as_ref()).collect();
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(refs.as_slice(), |r| r.get::<_, String>(0))?;
            for row in rows {
                if let Some(day) = day_key_of_ts(&row?) {
                    *fell_by_day.entry(day).or_insert(0) += 1;
                }
            }
        }

        // ---- Daily-miss replay ------------------------------------------------
        // The shared helpers above (see their docs for the semantics).
        let events = fetch_life_events(&conn)?;
        let axes = if scope.is_empty() {
            HashMap::new()
        } else {
            fetch_item_axes(&conn)?
        };

        let (start_d, end_d) = day_span(&conn, since, until, today_d)?;

        // The subject's per-day counts — the day rows, the streak, and the
        // heatmap all read these.
        let per_day: BTreeMap<String, i64> = done_by_day
            .iter()
            .map(|(day, m)| (day.clone(), m.values().filter(|e| e.done).count() as i64))
            .collect();

        let mut days: Vec<DayStat> = Vec::new();
        let mut totals = Totals::default();
        let mut idx = 0usize;
        // item → standing as of the day being processed.
        let mut live: HashMap<String, LiveItem> = HashMap::new();
        let mut d = start_d;
        while d <= end_d {
            let day = d.format("%Y-%m-%d").to_string();
            // The day ends where the next logical day begins — 06:00 the
            // following wall-clock morning.
            let day_end = day_start_prefix(&(d + chrono::Duration::days(1)).format("%Y-%m-%d").to_string());
            while idx < events.len() && events[idx].ts < day_end {
                apply_life_event(&mut live, &events[idx]);
                idx += 1;
            }

            let count = per_day.get(&day).copied().unwrap_or(0);

            // The current day's habits aren't "missed" — the day is still
            // live; misses are a day-end verdict.
            let mut daily_missed = 0i64;
            if day != today {
                let done_daily: HashSet<String> = done_all_by_day.get(&day).map_or_else(HashSet::new, |m| {
                    m.iter()
                        .filter(|(_, e)| e.done && e.from_section.as_deref() == Some("daily"))
                        .map(|(id, _)| id.clone())
                        .collect()
                });
                daily_missed =
                    daily_missed_texts(&live, &done_daily, &axes, &scope).len() as i64;
            }
            let today_missed = fell_by_day.get(&day).copied().unwrap_or(0);

            totals.count += count;
            totals.daily_missed += daily_missed;
            totals.today_missed += today_missed;
            days.push(DayStat { date: day, count, daily_missed, today_missed });
            d += chrono::Duration::days(1);
        }

        // Current streak: consecutive days with ≥1 effective completion,
        // walking back from today. A zero today is skipped (the day is still
        // live), but every earlier day must have one. The scan window is at
        // least the heatmap's ~7 months, which bounds any realistic streak.
        let has_done = |d: NaiveDate| -> bool {
            let day = d.format("%Y-%m-%d").to_string();
            per_day.get(&day).map_or(false, |&c| c > 0)
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
        let heatmap = heat_days(&per_day, &heat_start, &today);

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
        let projects = finish_projects(&conn, proj_counts)?;
        let priorities = finish_priorities(tier_counts);

        Ok(DashboardStats { days, heatmap, projects, priorities, totals })
    }

    /// The Created dashboard: one pass over `created` actions — each row is
    /// a task that entered the list, carrying its axes at birth. No
    /// effective-set folding (a creation is never undone), no replay, no
    /// streak: the done-only verdicts stay zero and the frontend hides their
    /// cards. Day keys follow the same 6am boundary, so a 1am capture
    /// belongs to yesterday.
    fn created_dashboard(
        &self, since: Option<&str>, until: Option<&str>, filter: &ScopeFilter,
    ) -> anyhow::Result<DashboardStats> {
        use chrono::NaiveDate;
        let scope = filter.scope();
        let conn = self.conn.lock().unwrap();
        let today = today_iso();
        let today_d = NaiveDate::parse_from_str(&today, "%Y-%m-%d")?;
        let heat_start = (today_d - chrono::Duration::days(HEATMAP_LOOKBACK_DAYS))
            .format("%Y-%m-%d")
            .to_string();
        let scan_end = day_start_prefix(until.unwrap_or("9999-12-31"));
        let (start_d, end_d) = day_span(&conn, since, until, today_d)?;
        let range_start = start_d.format("%Y-%m-%d").to_string();
        let range_end = end_d.format("%Y-%m-%d").to_string();

        // Counted in Rust for the same reason as every day-keyed fold — the
        // logical day shifts the wall-clock date back past 6am, which SQL
        // can't express over the text timestamps.
        let mut per_day: BTreeMap<String, i64> = BTreeMap::new();
        let mut proj_counts: HashMap<Option<String>, i64> = HashMap::new();
        let mut tier_counts: HashMap<Option<i64>, i64> = HashMap::new();
        {
            let mut sql = String::from(
                "SELECT timestamp, project, priority FROM actions
                 WHERE item_id IS NOT NULL AND action = 'created'
                   AND timestamp >= ? AND timestamp < ?",
            );
            let mut pv: Vec<Box<dyn rusqlite::ToSql>> =
                vec![Box::new(since.map(day_start_prefix).unwrap_or_default()), Box::new(scan_end)];
            scope.push_sql(&mut sql, &mut pv);
            let refs: Vec<&dyn rusqlite::ToSql> = pv.iter().map(|p| p.as_ref()).collect();
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(refs.as_slice(), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                ))
            })?;
            for row in rows {
                let (ts, project, priority) = row?;
                let Some(day) = day_key_of_ts(&ts) else { continue };
                *per_day.entry(day.clone()).or_insert(0) += 1;
                if day.as_str() >= range_start.as_str() && day.as_str() <= range_end.as_str() {
                    *proj_counts.entry(project).or_insert(0) += 1;
                    *tier_counts.entry(priority).or_insert(0) += 1;
                }
            }
        }

        let mut days: Vec<DayStat> = Vec::new();
        let mut totals = Totals::default();
        let mut d = start_d;
        while d <= end_d {
            let day = d.format("%Y-%m-%d").to_string();
            let count = per_day.get(&day).copied().unwrap_or(0);
            totals.count += count;
            days.push(DayStat { date: day, count, daily_missed: 0, today_missed: 0 });
            d += chrono::Duration::days(1);
        }

        let heatmap = heat_days(&per_day, &heat_start, &today);
        let projects = finish_projects(&conn, proj_counts)?;
        let priorities = finish_priorities(tier_counts);
        Ok(DashboardStats { days, heatmap, projects, priorities, totals })
    }

    /// One day at task level — what the ledger's expanded row renders, for
    /// either subject. `filter` scopes it exactly like journal_dashboard.
    /// `secs` is layered on by the command wrapper in Done mode from
    /// `session_time_by_day` (unscoped — time doesn't follow the filter).
    pub fn day_detail(
        &self, date: &str, filter: &ScopeFilter, subject: Subject,
    ) -> anyhow::Result<DayDetail> {
        match subject {
            Subject::Done => self.done_day_detail(date, filter),
            Subject::Created => self.created_day_detail(date, filter),
        }
    }

    /// The Done lens: the effective completions (per item, only the day's
    /// LAST completed/uncompleted event counts), the fell_to_backlog rows,
    /// and the miss replay frozen at this day's end.
    fn done_day_detail(&self, date: &str, filter: &ScopeFilter) -> anyhow::Result<DayDetail> {
        let scope = filter.scope();
        let conn = self.conn.lock().unwrap();
        let next = next_day(date)?;

        // Effective completions: per item, only the day's LAST completed/
        // uncompleted event counts (an unchecked-never-redone completion
        // doesn't; a re-completed misclick counts once, at its final time).
        // Folded in id order; survivors sorted by their last completion time.
        // `slots` is the scoped fold (what renders); `done_sections` is the
        // unscoped fold (the miss replay's done-check — see journal_dashboard).
        let mut slots: HashMap<String, TaskDetail> = HashMap::new();
        let mut done_sections: HashMap<String, Option<String>> = HashMap::new();
        {
            let mut stmt = conn.prepare(
                "SELECT item_id, item_text, action, timestamp, from_section, project, priority
                 FROM actions
                 WHERE item_id IS NOT NULL AND action IN ('completed','uncompleted')
                   AND timestamp >= ?1 AND timestamp < ?2
                 ORDER BY id",
            )?;
            let rows = stmt.query_map(params![day_start_prefix(date), day_start_prefix(&next)], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, Option<i64>>(6)?,
                ))
            })?;
            for row in rows {
                let (item, text, action, ts, from_section, project, priority) = row?;
                if action == "completed" {
                    done_sections.insert(item.clone(), from_section);
                    if scope.allows(&project, &priority) {
                        slots.insert(
                            item.clone(),
                            TaskDetail {
                                item_id: item.clone(),
                                time: ts[11..16].to_string(),
                                text,
                                project,
                                priority,
                                secs: 0,
                            },
                        );
                    }
                } else {
                    slots.remove(&item);
                    done_sections.remove(&item);
                }
            }
        }
        let mut tasks: Vec<TaskDetail> = slots.into_values().collect();
        tasks.sort_by(|a, b| a.time.cmp(&b.time)); // zero-padded HH:MM sorts chronologically

        // The sweep's record of today tasks the day ended without, scoped by
        // the snapshot axes like everything else.
        let mut fell: Vec<FellTaskDetail> = Vec::new();
        {
            let mut sql = String::from(
                "SELECT substr(timestamp,12,5), item_text FROM actions
                 WHERE item_id IS NOT NULL AND action = 'fell_to_backlog'
                   AND timestamp >= ? AND timestamp < ?",
            );
            let mut pv: Vec<Box<dyn rusqlite::ToSql>> =
                vec![Box::new(day_start_prefix(date)), Box::new(day_start_prefix(&next))];
            scope.push_sql(&mut sql, &mut pv);
            sql.push_str(" ORDER BY id");
            let refs: Vec<&dyn rusqlite::ToSql> = pv.iter().map(|p| p.as_ref()).collect();
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(refs.as_slice(), |r| {
                Ok(FellTaskDetail { time: r.get(0)?, text: r.get(1)? })
            })?;
            for row in rows {
                fell.push(row?);
            }
        }

        // Missed habits: the replay frozen at this day's end. The live today
        // has no verdict yet.
        let mut daily_missed: Vec<String> = Vec::new();
        if date != today_iso() {
            // The replay frozen at this day's end — 06:00 the next wall-clock
            // morning. The live today has no verdict yet.
            let day_end = day_start_prefix(&next);
            let mut live: HashMap<String, LiveItem> = HashMap::new();
            for ev in &fetch_life_events(&conn)? {
                if ev.ts > day_end {
                    break;
                }
                apply_life_event(&mut live, ev);
            }
            let axes = if scope.is_empty() {
                HashMap::new()
            } else {
                fetch_item_axes(&conn)?
            };
            let done_daily: HashSet<String> = done_sections
                .iter()
                .filter(|(_, sec)| sec.as_deref() == Some("daily"))
                .map(|(id, _)| id.clone())
                .collect();
            daily_missed = daily_missed_texts(&live, &done_daily, &axes, &scope);        }

        Ok(DayDetail { date: date.to_string(), tasks, fell, daily_missed })
    }

    /// The Created lens: the tasks that entered the list that day, as their
    /// birth-time snapshots. No fold — a creation is never undone. `fell`/
    /// `daily_missed` are done-only and stay empty.
    fn created_day_detail(&self, date: &str, filter: &ScopeFilter) -> anyhow::Result<DayDetail> {
        let scope = filter.scope();
        let conn = self.conn.lock().unwrap();
        let next = next_day(date)?;
        let mut sql = String::from(
            "SELECT item_id, item_text, substr(timestamp,12,5), project, priority FROM actions
             WHERE item_id IS NOT NULL AND action = 'created'
               AND timestamp >= ? AND timestamp < ?",
        );
        let mut pv: Vec<Box<dyn rusqlite::ToSql>> =
            vec![Box::new(day_start_prefix(date)), Box::new(day_start_prefix(&next))];
        scope.push_sql(&mut sql, &mut pv);
        sql.push_str(" ORDER BY id");
        let refs: Vec<&dyn rusqlite::ToSql> = pv.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql)?;
        let mut tasks: Vec<TaskDetail> = stmt
            .query_map(refs.as_slice(), |r| {
                Ok(TaskDetail {
                    item_id: r.get(0)?,
                    text: r.get(1)?,
                    time: r.get(2)?,
                    project: r.get(3)?,
                    priority: r.get(4)?,
                    secs: 0,
                })
            })?
            .collect::<Result<_, _>>()?;
        tasks.sort_by(|a, b| a.time.cmp(&b.time));
        Ok(DayDetail { date: date.to_string(), tasks, fell: Vec::new(), daily_missed: Vec::new() })
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
            // Sweeps run at/after the 6am boundary, so 06:01 belongs to Jan 3.
            act(&conn, "C", "created", None, Some("today"), None, None, "2026-01-02T09:00:00");
            act(&conn, "C", "fell_to_backlog", Some("today"), Some("backlog"), None, None,
                "2026-01-03T06:01:00");
        }
        let s = db.journal_dashboard(Some("2026-01-02"), Some("2026-01-06"), &ScopeFilter::default(), Subject::Done).unwrap();
        let by = by_date(&s);
        assert_eq!(by["2026-01-02"].count, 2);
        assert_eq!(by["2026-01-02"].daily_missed, 0);
        assert_eq!(by["2026-01-03"].count, 1);
        assert_eq!(by["2026-01-03"].daily_missed, 1); // B skipped
        assert_eq!(by["2026-01-03"].today_missed, 1); // C fell
        assert_eq!(by["2026-01-04"].daily_missed, 0);
        assert_eq!(by["2026-01-05"].daily_missed, 1);
        assert_eq!(s.totals.count, 6);
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
        let s = db.journal_dashboard(Some("2026-01-02"), Some("2026-01-03"), &ScopeFilter::default(), Subject::Done).unwrap();
        assert_eq!(s.days[0].count, 2); // D once + E; F's completion was undone
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
    fn day_detail_lists_done_fell_and_missed_habits() {
        let (db, dir) = tmp_db();
        {
            let conn = db.conn.lock().unwrap();
            // Habits: A done on Jan 2, B missed.
            act(&conn, "A", "created", None, Some("daily"), None, None, "2026-01-01T09:00:00");
            act(&conn, "B", "created", None, Some("daily"), None, None, "2026-01-01T09:00:00");
            act(&conn, "A", "completed", Some("daily"), Some("daily"), None, None, "2026-01-02T08:00:00");
            // D: complete → uncheck → complete again — one entry, at the final time.
            act(&conn, "D", "created", None, Some("today"), None, None, "2026-01-01T09:00:00");
            act(&conn, "D", "completed", Some("today"), Some("today"), Some("meridian"), Some(1), "2026-01-02T09:00:00");
            act(&conn, "D", "uncompleted", Some("today"), Some("today"), None, None, "2026-01-02T10:00:00");
            act(&conn, "D", "completed", Some("today"), Some("today"), Some("meridian"), Some(1), "2026-01-02T11:30:00");
            // F: completed then unchecked and left — not done.
            act(&conn, "F", "created", None, Some("today"), None, None, "2026-01-01T09:00:00");
            act(&conn, "F", "completed", Some("today"), Some("today"), None, None, "2026-01-02T12:00:00");
            act(&conn, "F", "uncompleted", Some("today"), Some("today"), None, None, "2026-01-02T13:00:00");
            // E from the Backlog.
            act(&conn, "E", "created", None, Some("backlog"), None, None, "2026-01-01T09:00:00");
            act(&conn, "E", "completed", Some("backlog"), Some("backlog"), None, None, "2026-01-02T14:00:00");
            // C fell at the day boundary.
            act(&conn, "C", "created", None, Some("today"), None, None, "2026-01-01T09:00:00");
            act(&conn, "C", "fell_to_backlog", Some("today"), Some("backlog"), None, None, "2026-01-02T06:01:00");
        }
        let d = db.day_detail("2026-01-02", &ScopeFilter::default(), Subject::Done).unwrap();
        let texts: Vec<&str> = d.tasks.iter().map(|t| t.text.as_str()).collect();
        assert_eq!(texts, ["A", "D", "E"]); // chronological, D once, F gone
        assert_eq!(d.tasks[1].time, "11:30"); // the final completion's time
        assert_eq!(d.tasks[1].project.as_deref(), Some("meridian"));
        let fell: Vec<&str> = d.fell.iter().map(|f| f.text.as_str()).collect();
        assert_eq!(fell, ["C"]);
        assert_eq!(d.daily_missed, ["B"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The 6am→6am day: a completion logged at 01:23 the following
    /// wall-clock morning keys to the previous logical day — in the totals,
    /// the day rows, and the day ledger alike (its HH:MM still reads 01:23).
    #[test]
    fn late_night_completions_belong_to_the_previous_logical_day() {
        let (db, dir) = tmp_db();
        {
            let conn = db.conn.lock().unwrap();
            act(&conn, "N", "created", None, Some("today"), None, None, "2026-01-01T21:00:00");
            act(&conn, "N", "completed", Some("today"), Some("today"), None, None, "2026-01-02T01:23:00");
        }
        let s = db.journal_dashboard(Some("2026-01-01"), Some("2026-01-02"), &ScopeFilter::default(), Subject::Done).unwrap();
        assert_eq!(s.totals.count, 1);
        assert_eq!(s.days.iter().find(|d| d.date == "2026-01-01").map(|d| d.count), Some(1));
        let d = db.day_detail("2026-01-01", &ScopeFilter::default(), Subject::Done).unwrap();
        assert_eq!(d.tasks.len(), 1);
        assert_eq!(d.tasks[0].time, "01:23");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn streak_tolerates_a_live_today() {
        let (db, dir) = tmp_db();
        // Anchor on the logical today, the same day the dashboard keys off.
        let today = chrono::NaiveDate::parse_from_str(&today_iso(), "%Y-%m-%d").unwrap();
        let day = |back: i64| (today - chrono::Duration::days(back)).format("%Y-%m-%d").to_string();
        {
            let conn = db.conn.lock().unwrap();
            // Done yesterday and the two days before; today still empty.
            for back in [1, 2, 3] {
                act(&conn, "S", "completed", Some("today"), Some("today"), None, None,
                    &format!("{}T09:00:00", day(back)));
            }
        }
        let s = db.journal_dashboard(None, None, &ScopeFilter::default(), Subject::Done).unwrap();
        assert_eq!(s.totals.streak, 3, "an empty live today must not break the streak");
        {
            let conn = db.conn.lock().unwrap();
            act(&conn, "S", "completed", Some("today"), Some("today"), None, None,
                &format!("{}T10:00:00", day(0)));
        }
        let s = db.journal_dashboard(None, None, &ScopeFilter::default(), Subject::Done).unwrap();
        assert_eq!(s.totals.streak, 4);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pauses_shape_the_miss_replay() {
        let (db, dir) = tmp_db();
        let a = db.create_item("habit a", "daily").unwrap();
        let b = db.create_item("habit b", "daily").unwrap();
        // B's pause window: Jan 3 → Jan 5. The actions carry real timestamps;
        // backdate them onto the replay's calendar like the created/completed.
        db.hide_item(&b.id, "forever").unwrap();
        db.unhide_item(&b.id).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE actions SET timestamp = '2026-01-01T09:00:00' WHERE action = 'created'",
                [],
            )
            .unwrap();
            // A completes every day Jan 1–5, so B alone drives the miss counts.
            for d in 1..=5 {
                act(&conn, &a.id, "completed", Some("daily"), Some("daily"), None, None,
                    &format!("2026-01-0{d}T10:00:00"));
            }
            conn.execute(
                "UPDATE actions SET timestamp = '2026-01-03T12:00:00' WHERE action = 'paused'",
                [],
            )
            .unwrap();
            conn.execute(
                "UPDATE actions SET timestamp = '2026-01-05T12:00:00' WHERE action = 'unpaused'",
                [],
            )
            .unwrap();
        }
        let s = db.journal_dashboard(Some("2026-01-01"), Some("2026-01-06"), &ScopeFilter::default(), Subject::Done).unwrap();
        // Jan 1–2: B is alive, not paused, not done → missed (A is done).
        assert_eq!(s.days[0].daily_missed, 1);
        assert_eq!(s.days[1].daily_missed, 1);
        assert_eq!(s.days[1].count, 1);
        // Jan 3–4: B is paused — outside the population, never missed.
        assert_eq!(s.days[2].daily_missed, 0);
        assert_eq!(s.days[3].daily_missed, 0);
        // Jan 5: the unpause lands mid-day — B is expected again and missed.
        assert_eq!(s.days[4].daily_missed, 1);
        // The single-day detail shares the replay: Jan 4 (paused) vs Jan 2.
        let d4 = db.day_detail("2026-01-04", &ScopeFilter::default(), Subject::Done).unwrap();
        assert!(d4.daily_missed.is_empty());
        let d2 = db.day_detail("2026-01-02", &ScopeFilter::default(), Subject::Done).unwrap();
        assert_eq!(d2.daily_missed, vec!["habit b".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A scope filter narrows the whole dashboard: done counts and splits read
    /// the completion snapshots; fell counts read theirs; the miss replay's
    /// population reads the habits' current axes (a habit outside the filter
    /// is neither expected nor missed); the unscoped done-check keeps a
    /// completed habit from ever reading as a phantom miss.
    #[test]
    fn scope_filter_narrows_every_derivation() {
        let (db, dir) = tmp_db();
        {
            let conn = db.conn.lock().unwrap();
            // Habits: H1 in meridian (completed), H2 in growth (skipped) —
            // H2 must NOT read as missed under a meridian filter.
            act(&conn, "H1", "created", None, Some("daily"), Some("meridian"), None, "2026-01-01T09:00:00");
            act(&conn, "H2", "created", None, Some("daily"), Some("growth"), None, "2026-01-01T09:00:00");
            act(&conn, "H1", "completed", Some("daily"), Some("daily"), Some("meridian"), None, "2026-01-02T08:00:00");
            // Tasks: T1 meridian P1 (completed), T2 unattributed (completed),
            // T3 growth (fell to backlog).
            act(&conn, "T1", "created", None, Some("today"), Some("meridian"), Some(1), "2026-01-01T09:00:00");
            act(&conn, "T1", "completed", Some("today"), Some("today"), Some("meridian"), Some(1), "2026-01-02T09:00:00");
            act(&conn, "T2", "created", None, Some("today"), None, None, "2026-01-01T09:00:00");
            act(&conn, "T2", "completed", Some("today"), Some("today"), None, None, "2026-01-02T10:00:00");
            act(&conn, "T3", "created", None, Some("today"), Some("growth"), None, "2026-01-01T09:00:00");
            act(&conn, "T3", "fell_to_backlog", Some("today"), Some("backlog"), Some("growth"), None, "2026-01-02T06:01:00");
        }
        let filter = ScopeFilter {
            projects: Some(vec![Some("meridian".into())]),
            priorities: None,
        };
        let s = db.journal_dashboard(Some("2026-01-02"), Some("2026-01-03"), &filter, Subject::Done).unwrap();
        assert_eq!(s.days[0].count, 2); // H1 + T1; T2 is unattributed
        assert_eq!(s.days[0].daily_missed, 0); // H2 is outside the filter
        assert_eq!(s.days[0].today_missed, 0); // T3 fell, but it's growth
        assert_eq!(s.totals.count, 2);
        // Splits derive over the scoped set only.
        let names: Vec<(Option<&str>, i64)> =
            s.projects.iter().map(|p| (p.name.as_deref(), p.count)).collect();
        assert_eq!(names, [(Some("meridian"), 2)]);
        let tiers: Vec<(Option<i64>, i64)> =
            s.priorities.iter().map(|t| (t.tier, t.count)).collect();
        assert_eq!(tiers, [(Some(1), 1), (Some(2), 0), (Some(3), 0), (None, 1)]); // H1 unmarked + T1

        // Priority filter: only T1 (P1). H2 (growth, unmarked) stays outside;
        // H1 (unmarked) is outside too — 0 missed, not 1.
        let filter = ScopeFilter {
            projects: None,
            priorities: Some(vec![Some(1)]),
        };
        let s = db.journal_dashboard(Some("2026-01-02"), Some("2026-01-03"), &filter, Subject::Done).unwrap();
        assert_eq!(s.days[0].count, 1);
        assert_eq!(s.days[0].daily_missed, 0);
        assert_eq!(s.days[0].today_missed, 0);

        // The "no project" bucket: None inside the selection.
        let filter = ScopeFilter {
            projects: Some(vec![None]),
            priorities: None,
        };
        let s = db.journal_dashboard(Some("2026-01-02"), Some("2026-01-03"), &filter, Subject::Done).unwrap();
        assert_eq!(s.days[0].count, 1); // T2 only
        assert_eq!(s.totals.count, 1);

        // Day detail follows the same scope: done list filtered, fell filtered,
        // missed habits filtered.
        let filter = ScopeFilter {
            projects: Some(vec![Some("meridian".into())]),
            priorities: None,
        };
        let d = db.day_detail("2026-01-02", &filter, Subject::Done).unwrap();
        let texts: Vec<&str> = d.tasks.iter().map(|t| t.text.as_str()).collect();
        assert_eq!(texts.len(), 2); // H1 + T1 (T2 excluded)
        assert!(d.fell.is_empty()); // T3 is growth
        assert!(d.daily_missed.is_empty()); // H2 is growth

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A habit reassigned after the fact (completions snapshotted under the
    /// old axes, current row under the new ones) never reads as a phantom
    /// miss under a filter matching its CURRENT axes: the population follows
    /// the habit, the done-check is unscoped.
    #[test]
    fn reassigned_habit_is_never_a_phantom_miss() {
        let (db, dir) = tmp_db();
        let h = db.create_item("habit h", "daily").unwrap();
        db.set_item_priority(&h.id, Some(2)).unwrap(); // the current axes
        {
            let conn = db.conn.lock().unwrap();
            // The habit existed from Jan 1, and its Jan 2 completion was
            // snapshotted before the tier existed (axes NULL).
            conn.execute(
                "UPDATE actions SET timestamp = '2026-01-01T09:00:00' WHERE action = 'created'",
                [],
            )
            .unwrap();
            act(&conn, &h.id, "completed", Some("daily"), Some("daily"), None, None,
                "2026-01-02T08:00:00");
        }
        let filter = ScopeFilter {
            projects: None,
            priorities: Some(vec![Some(2)]),
        };
        let s = db.journal_dashboard(Some("2026-01-02"), Some("2026-01-03"), &filter, Subject::Done).unwrap();
        // H is in the population (current priority 2) and was completed —
        // the unscoped done-check sees it. 0 missed, not 1.
        assert_eq!(s.days[0].daily_missed, 0);
        // Its completion still credits the unmarked tier (snapshot), so the
        // scoped done count is 0 — completion axes are deletion-proof history.
        assert_eq!(s.days[0].count, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The Created subject: each `created` action is one count (a completion
    /// of the same task adds nothing), scoped by the birth-time snapshots;
    /// the done-only verdicts stay zero; the day detail lists the creations.
    #[test]
    fn created_subject_counts_creations_scoped_by_birth_axes() {
        let (db, dir) = tmp_db();
        {
            let conn = db.conn.lock().unwrap();
            // One creation on Jan 1, three on Jan 2, one completion on Jan 3.
            act(&conn, "A", "created", None, Some("today"), Some("meridian"), Some(1), "2026-01-01T09:00:00");
            act(&conn, "B", "created", None, Some("today"), Some("meridian"), None, "2026-01-02T09:00:00");
            act(&conn, "C", "created", None, Some("backlog"), None, None, "2026-01-02T10:00:00");
            act(&conn, "D", "created", None, Some("today"), Some("growth"), None, "2026-01-02T11:00:00");
            act(&conn, "B", "completed", Some("today"), Some("today"), Some("meridian"), None, "2026-01-03T09:00:00");
        }
        let s = db.journal_dashboard(Some("2026-01-01"), Some("2026-01-04"), &ScopeFilter::default(), Subject::Created).unwrap();
        assert_eq!(s.totals.count, 4);
        assert_eq!(s.days.iter().find(|d| d.date == "2026-01-01").map(|d| d.count), Some(1));
        assert_eq!(s.days.iter().find(|d| d.date == "2026-01-02").map(|d| d.count), Some(3));
        assert_eq!(s.totals.streak, 0);
        assert_eq!(s.totals.daily_missed, 0);
        assert_eq!(s.totals.today_missed, 0);
        // Splits read the birth-time snapshots.
        let names: Vec<(Option<&str>, i64)> =
            s.projects.iter().map(|p| (p.name.as_deref(), p.count)).collect();
        assert_eq!(names, [(Some("meridian"), 2), (Some("growth"), 1), (None, 1)]);

        // Scope: meridian only — A and B's births, not C/D.
        let filter = ScopeFilter { projects: Some(vec![Some("meridian".into())]), priorities: None };
        let s = db.journal_dashboard(Some("2026-01-01"), Some("2026-01-04"), &filter, Subject::Created).unwrap();
        assert_eq!(s.totals.count, 2);

        // The day detail lists the creations; the Done lens still counts
        // the completion.
        let d = db.day_detail("2026-01-02", &ScopeFilter::default(), Subject::Created).unwrap();
        let texts: Vec<&str> = d.tasks.iter().map(|t| t.text.as_str()).collect();
        assert_eq!(texts, ["B", "C", "D"]); // chronological
        assert_eq!(d.tasks[0].time, "09:00");
        assert!(d.fell.is_empty() && d.daily_missed.is_empty());
        let d = db.day_detail("2026-01-03", &ScopeFilter::default(), Subject::Done).unwrap();
        assert_eq!(d.tasks.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

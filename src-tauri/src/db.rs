// Database layer: connection, schema init, typed Item/Action model.
// One SQLite file at ~/Library/Application Support/DayApp/dayapp.db.
//
// rusqlite is synchronous, so callers wrap DB work in
// `tauri::async_runtime::spawn_blocking` to keep the UI thread free.

use std::sync::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub text: String,
    pub section: String,          // 'today' | 'daily' | 'backlog'
    pub status: String,           // 'active' | 'done'
    pub last_completed_date: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
    pub hidden: bool,             // soft-archive; hidden=1 keeps row out of active lists
    pub hidden_until: Option<String>,  // ISO YYYY-MM-DD when a time-limited hide expires; NULL = forever
    pub project_id: Option<String>,    // assigned project (housekeeping — not logged to actions)
    pub remind_at: Option<String>,     // ISO YYYY-MM-DD when a backlog item auto-promotes to today
    pub priority: Option<i64>,         // urgency tier 1–3 (housekeeping — not logged); Backlog sorts by it
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub id: i64,
    pub item_id: String,
    pub item_text: String,
    pub action: String,
    pub from_section: Option<String>,
    pub to_section: Option<String>,
    pub from_status: Option<String>,
    pub to_status: Option<String>,
    pub timestamp: String,
}

/// How `list` treats hidden rows — the three ⌘P visibility modes over the main
/// list: the default excludes them, "Show All" includes them inline, and
/// "Show Hidden Only" returns just them (the archive view).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HiddenFilter {
    Exclude,
    Include,
    Only,
}

impl HiddenFilter {
    /// SQL fragment appending the hidden-row predicate (empty for Include,
    /// since those rows need no filter). Shared by the items and notes lists.
    pub fn clause(self) -> &'static str {
        match self {
            HiddenFilter::Exclude => " AND hidden = 0",
            HiddenFilter::Include => "",
            HiddenFilter::Only => " AND hidden = 1",
        }
    }
}

// Single shared connection behind a mutex. DayApp is single-user, single-process,
// low concurrency — a Mutex<Connection> is fine and avoids a pool dependency.
#[derive(Debug)]
pub struct Db(pub Mutex<Connection>);

impl Db {
    pub fn open(path: &std::path::Path) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;     // crash-safe, fast
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Self::migrate(&conn)?;
        Ok(Self(Mutex::new(conn)))
    }

    fn migrate(conn: &Connection) -> anyhow::Result<()> {
        let schema = include_str!("../schema.sql");
        conn.execute_batch(schema)?;
        // schema.sql only creates new columns on fresh tables. For DBs created
        // before the hide feature existed, ALTER TABLE adds the columns
        // idempotently — PRAGMA table_info tells us which are missing.
        // ensure_column logs when it actually adds something, so we can see
        // migrations in the log without noise on steady-state launches.
        ensure_column(conn, "items", "hidden", "INTEGER NOT NULL DEFAULT 0")?;
        ensure_column(conn, "items", "hidden_until", "TEXT")?;
        ensure_column(conn, "items", "project_id", "TEXT")?;
        ensure_column(conn, "items", "remind_at", "TEXT")?;
        ensure_column(conn, "items", "priority", "INTEGER")?;
        ensure_column(conn, "notes", "hidden", "INTEGER NOT NULL DEFAULT 0")?;
        ensure_column(conn, "notes", "hidden_until", "TEXT")?;
        Ok(())
    }

    // ---- Reads -----------------------------------------------------------

    /// All items in a section. `hidden` picks the
    /// visibility mode: Exclude (default) keeps archived rows out, Include is
    /// the ⌘P "Show All" mode (hidden rows render inline — they keep their
    /// sort_order, so they appear where they were hidden), Only is "Show
    /// Hidden Only". In Only mode the status filter is skipped — archived rows
    /// show as-is, like the old dedicated Hidden view.
    ///
    /// Ordering: the Backlog is sorted by priority first (NULL last), then
    /// manual order — priority is the primary axis there, DnD orders within a
    /// tier. Today/Daily are purely manual (sort_order).
    pub fn list(&self, section: &str, include_done: bool, hidden: HiddenFilter) -> anyhow::Result<Vec<Item>> {
        let conn = self.0.lock().unwrap();
        let mut sql = String::from(
            "SELECT id,text,section,status,last_completed_date,sort_order,created_at,updated_at,hidden,hidden_until,project_id,remind_at,priority
             FROM items WHERE section = ?1");
        if !include_done && hidden != HiddenFilter::Only {
            sql.push_str(" AND status = 'active'");
        }
        sql.push_str(hidden.clause());
        sql.push_str(if section == "backlog" {
            " ORDER BY COALESCE(priority, 99), sort_order, created_at"
        } else {
            " ORDER BY sort_order, created_at"
        });
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![section], item_from_row)?;
        let mut out = Vec::new();
        for row in rows { out.push(row?); }
        Ok(out)
    }

    // ---- Writes ----------------------------------------------------------
    //
    // Every write mutates `items` AND appends to `actions`. The log is the journal;
    // it must never drift from the live row. These are wrapped in a transaction.

    pub fn create_item(&self, text: &str, section: &str) -> anyhow::Result<Item> {
        let conn = self.0.lock().unwrap();
        let now = now_iso();
        let id = ulid::Ulid::new().to_string();
        let max_order: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) FROM items WHERE section = ?1",
                params![section], |r| r.get(0),
            )?;
        let sort_order = max_order + 1;

        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO items (id,text,section,status,last_completed_date,sort_order,created_at,updated_at)
             VALUES (?1,?2,?3,'active',NULL,?4,?5,?5)",
            params![id, text, section, sort_order, now],
        )?;
        log_action(&tx, &id, text, "created", None, Some(section), None, Some("active"), &now)?;
        tx.commit()?;

        Ok(Item {
            id, text: text.to_string(), section: section.to_string(),
            status: "active".into(), last_completed_date: None,
            sort_order, created_at: now.clone(), updated_at: now,
            hidden: false, hidden_until: None,
            project_id: None, remind_at: None, priority: None,
        })
    }

    pub fn edit_item(&self, id: &str, text: &str) -> anyhow::Result<()> {
        let conn = self.0.lock().unwrap();
        let now = now_iso();
        let tx = conn.unchecked_transaction()?;
        let (old_text, section): (String, String) = tx.query_row(
            "SELECT text, section FROM items WHERE id = ?1", params![id],
            |r| Ok((r.get(0)?, r.get(1)?)))?;
        tx.execute(
            "UPDATE items SET text = ?1, updated_at = ?2 WHERE id = ?3",
            params![text, now, id])?;
        // Only log if it actually changed; keeps the journal clean.
        if old_text != text {
            log_action(&tx, id, text, "edited", Some(&section), Some(&section), None, None, &now)?;
        }
        Ok(tx.commit()?)
    }

    /// Mark a non-daily item done. Hides from active lists.
    /// For a daily item, records completion for today; item stays visible but greyed.
    pub fn complete_item(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.0.lock().unwrap();
        let now = now_iso();
        let today = today_iso();
        let tx = conn.unchecked_transaction()?;

        let (text, section, status): (String, String, String) = tx.query_row(
            "SELECT text, section, status FROM items WHERE id = ?1", params![id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?;

        if section == "daily" {
            // Daily: don't flip status — record completion for today. Item stays
            // visible-but-greyed until tomorrow (driven by last_completed_date == today).
            tx.execute(
                "UPDATE items SET last_completed_date = ?1, updated_at = ?2 WHERE id = ?3",
                params![today, now, id])?;
            log_action(&tx, id, &text, "completed", Some(&section), Some(&section),
                       Some(&status), Some(&status), &now)?;
        } else {
            tx.execute(
                "UPDATE items SET status = 'done', updated_at = ?1 WHERE id = ?2",
                params![now, id])?;
            log_action(&tx, id, &text, "completed", Some(&section), Some(&section),
                       Some(&status), Some("done"), &now)?;
        }
        Ok(tx.commit()?)
    }

    /// Move an item to a different section (drag, or programmatic).
    /// Re-indexes sort_order in the destination so it stays contiguous.
    pub fn move_item(&self, id: &str, to_section: &str, new_index: i64) -> anyhow::Result<()> {
        let conn = self.0.lock().unwrap();
        let now = now_iso();
        let tx = conn.unchecked_transaction()?;

        let (text, from_section): (String, String) = tx.query_row(
            "SELECT text, section FROM items WHERE id = ?1", params![id],
            |r| Ok((r.get(0)?, r.get(1)?)))?;

        if from_section != to_section {
            tx.execute(
                "UPDATE items SET section = ?1, updated_at = ?2 WHERE id = ?3",
                params![to_section, now, id])?;
            log_action(&tx, id, &text, "moved",
                       Some(&from_section), Some(to_section), None, None, &now)?;
        }

        // Re-index destination section so sort_order is contiguous & matches new_index.
        // Simple approach: load all ids in dest in desired order, write 0..N.
        // The Backlog is priority-sorted for display, so index in that same
        // order there — drops land where they visually fell (priority stays
        // the primary axis; manual order applies within a tier).
        let dest_order = if to_section == "backlog" {
            "ORDER BY COALESCE(priority, 99), sort_order, created_at"
        } else {
            "ORDER BY sort_order, created_at"
        };
        let mut ids: Vec<String> = {
            let mut stmt = tx.prepare(&format!(
                "SELECT id FROM items WHERE section = ?1 AND id != ?2 {dest_order}"
            ))?;
            let rows = stmt.query_map(params![to_section, id], |r| r.get::<_,String>(0))?;
            let mut v = Vec::new();
            for r in rows { v.push(r?); }
            v
        };
        let insert_at = (new_index as usize).min(ids.len());
        ids.insert(insert_at, id.to_string());
        for (i, row_id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE items SET sort_order = ?1 WHERE id = ?2",
                params![i as i64, row_id])?;
        }
        Ok(tx.commit()?)
    }

    pub fn delete_item(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.0.lock().unwrap();
        let now = now_iso();
        let tx = conn.unchecked_transaction()?;
        let (text, section): (String, String) = tx.query_row(
            "SELECT text, section FROM items WHERE id = ?1", params![id],
            |r| Ok((r.get(0)?, r.get(1)?)))?;
        tx.execute("DELETE FROM items WHERE id = ?1", params![id])?;
        log_action(&tx, id, &text, "deleted", Some(&section), None, None, None, &now)?;
        Ok(tx.commit()?)
    }

    // ---- Hide -------------------------------------------------------------
    //
    // Soft-archive: the row stays in `items` so it can be unhidden, but
    // `list()` filters hidden=0. `hidden_until` is NULL for "forever", else an
    // ISO date at which `unhide_expired_items` (run by the midnight sweep) clears
    // it. Deliberately not logged to `actions` — hide is housekeeping, not the
    // meaningful activity the journal records.

    /// Hide an item. `duration` is one of: forever | day | week | month.
    pub fn hide_item(&self, id: &str, duration: &str) -> anyhow::Result<()> {
        let conn = self.0.lock().unwrap();
        let now = now_iso();
        let hidden_until = hidden_until_for(duration);
        conn.execute(
            "UPDATE items SET hidden = 1, hidden_until = ?1, updated_at = ?2 WHERE id = ?3",
            params![hidden_until, now, id],
        )?;
        Ok(())
    }

    /// Unhide an item — clears both the flag and the expiry.
    pub fn unhide_item(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.0.lock().unwrap();
        let now = now_iso();
        conn.execute(
            "UPDATE items SET hidden = 0, hidden_until = NULL, updated_at = ?1 WHERE id = ?2",
            params![now, id],
        )?;
        Ok(())
    }

    /// Clear the hidden flag on any item whose time-limited hide has expired.
    /// Called by the launch + 60s-tick sweep, so hides auto-restore at midnight
    /// without a cron job. Idempotent. Returns the number of rows restored.
    pub fn unhide_expired_items(&self) -> anyhow::Result<usize> {
        let conn = self.0.lock().unwrap();
        let now = now_iso();
        let today = today_iso();
        let n = conn.execute(
            "UPDATE items SET hidden = 0, hidden_until = NULL, updated_at = ?1
             WHERE hidden = 1 AND hidden_until IS NOT NULL AND hidden_until <= ?2",
            params![now, today],
        )?;
        Ok(n)
    }

    /// Set (or clear) an item's reminder. `remind_at` is an ISO YYYY-MM-DD on
    /// which a backlog item auto-promotes to Today, or None to clear.
    /// Housekeeping — not logged to actions.
    pub fn set_reminder(&self, id: &str, remind_at: Option<&str>) -> anyhow::Result<()> {
        let conn = self.0.lock().unwrap();
        let now = now_iso();
        conn.execute(
            "UPDATE items SET remind_at = ?1, updated_at = ?2 WHERE id = ?3",
            params![remind_at, now, id],
        )?;
        Ok(())
    }

    /// Set (or clear) an item's priority (1–3, or None). Housekeeping like the
    /// project assignment — not logged to `actions`.
    pub fn set_item_priority(&self, id: &str, priority: Option<i64>) -> anyhow::Result<()> {
        let conn = self.0.lock().unwrap();
        let now = now_iso();
        conn.execute(
            "UPDATE items SET priority = ?1, updated_at = ?2 WHERE id = ?3",
            params![priority, now, id],
        )?;
        Ok(())
    }

    /// Promote any backlog item whose reminder has come due (remind_at <= today)
    /// to Today, clearing remind_at so it fires once. Logged as a `moved`
    /// action — no new action enum, so the existing CHECK constraint is untouched.
    /// Idempotent (clearing remind_at prevents re-promotion). Called un-gated on
    /// launch and inside run_sweep (harmless to call twice).
    pub fn promote_due_reminders(&self) -> anyhow::Result<usize> {
        let conn = self.0.lock().unwrap();
        let now = now_iso();
        let today = today_iso();

        let due: Vec<(String, String)> = {
            let mut stmt = conn.prepare(
                "SELECT id, text FROM items
                 WHERE section = 'backlog' AND status = 'active'
                   AND remind_at IS NOT NULL AND remind_at <= ?1")?;
            let rows = stmt.query_map(params![today], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
            let mut v = Vec::new();
            for r in rows { v.push(r?); }
            v
        };

        if due.is_empty() {
            return Ok(0);
        }

        let tx = conn.unchecked_transaction()?;
        for (id, text) in &due {
            tx.execute(
                "UPDATE items SET section = 'today', remind_at = NULL, updated_at = ?1 WHERE id = ?2",
                params![now, id])?;
            log_action(&tx, id, text, "moved",
                       Some("backlog"), Some("today"), None, None, &now)?;
        }
        tx.commit()?;
        Ok(due.len())
    }

    // ---- Sweep -----------------------------------------------------------

    /// The core "today resets" behaviour. Called on app startup.
    /// Idempotent: safe to call any number of times on the same day.
    pub fn run_sweep(&self) -> anyhow::Result<usize> {
        let conn = self.0.lock().unwrap();
        let now = now_iso();
        let today = today_iso();

        let last_sweep: Option<String> = conn.query_row(
            "SELECT value FROM meta WHERE key = 'last_sweep_date'",
            [], |r| r.get(0)).optional()?;

        if last_sweep.as_deref() == Some(today.as_str()) {
            return Ok(0); // already swept today
        }

        let tx = conn.unchecked_transaction()?;
        // Every active 'today' item that survived the night falls to backlog.
        let to_fall: Vec<(String,String)> = {
            let mut stmt = tx.prepare(
                "SELECT id, text FROM items WHERE section = 'today' AND status = 'active'")?;
            let rows = stmt.query_map([], |r| {
                Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?))
            })?;
            let mut v = Vec::new();
            for r in rows { v.push(r?); }
            v
        };

        for (id, text) in &to_fall {
            tx.execute(
                "UPDATE items SET section = 'backlog', updated_at = ?1 WHERE id = ?2",
                params![now, id])?;
            log_action(&tx, id, text, "fell_to_backlog",
                       Some("today"), Some("backlog"), None, None, &now)?;
        }

        // Bump last_sweep_date. Even if zero items fell, we still record the sweep
        // so we don't re-run.
        tx.execute(
            "INSERT INTO meta(key,value) VALUES('last_sweep_date',?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![today])?;

        // While we're already on the day boundary, clear any expired hides
        // (hidden_until <= today) for both items and notes — time-limited hides
        // auto-restore here, no separate job.
        tx.execute(
            "UPDATE items SET hidden = 0, hidden_until = NULL, updated_at = ?1
             WHERE hidden = 1 AND hidden_until IS NOT NULL AND hidden_until <= ?2",
            params![now, today])?;
        tx.execute(
            "UPDATE notes SET hidden = 0, hidden_until = NULL, updated_at = ?1
             WHERE hidden = 1 AND hidden_until IS NOT NULL AND hidden_until <= ?2",
            params![now, today])?;

        tx.commit()?;
        Ok(to_fall.len())
    }

    // ---- Log queries -----------------------------------------------------

    /// All actions in reverse-chronological order. This is the "journal".
    /// `since`/`until` are optional ISO date-prefix bounds (YYYY-MM-DD), compared
    /// lexicographically against timestamp (YYYY-MM-DDTHH:MM:SS) — so passing the
    /// *start* day as `since` and the *day after* the target as `until` yields a
    /// half-open [since, until) day/week/month range. NULL bounds are unbounded.
    pub fn list_actions(
        &self, limit: Option<i64>, since: Option<&str>, until: Option<&str>,
    ) -> anyhow::Result<Vec<Action>> {
        let conn = self.0.lock().unwrap();
        let limit = limit.unwrap_or(500);

        // Build the WHERE clause dynamically so each bound is optional; collect
        // positional params in the same order so bind indices line up.
        let mut sql = String::from(
            "SELECT id,item_id,item_text,action,from_section,to_section,from_status,to_status,timestamp
             FROM actions WHERE 1=1");
        let mut pv: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(s) = since { sql.push_str(" AND timestamp >= ?"); pv.push(Box::new(s.to_string())); }
        if let Some(u) = until { sql.push_str(" AND timestamp < ?"); pv.push(Box::new(u.to_string())); }
        sql.push_str(" ORDER BY id DESC LIMIT ?");
        pv.push(Box::new(limit));
        let refs: Vec<&dyn rusqlite::ToSql> = pv.iter().map(|p| p.as_ref()).collect();

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(refs.as_slice(), |r| {
            Ok(Action {
                id: r.get(0)?, item_id: r.get(1)?, item_text: r.get(2)?, action: r.get(3)?,
                from_section: r.get(4)?, to_section: r.get(5)?,
                from_status: r.get(6)?, to_status: r.get(7)?, timestamp: r.get(8)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows { out.push(r?); }
        Ok(out)
    }
}

fn log_action(
    tx: &rusqlite::Transaction,
    item_id: &str, item_text: &str, action: &str,
    from_section: Option<&str>, to_section: Option<&str>,
    from_status: Option<&str>, to_status: Option<&str>,
    timestamp: &str,
) -> anyhow::Result<()> {
    tx.execute(
        "INSERT INTO actions (item_id,item_text,action,from_section,to_section,from_status,to_status,timestamp)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![item_id, item_text, action, from_section, to_section, from_status, to_status, timestamp])?;
    Ok(())
}

// ---- Time helpers. Local time, ISO strings. No tz complexity in v1. -------

pub fn now_iso() -> String {
    use chrono::{Local, SecondsFormat};
    Local::now().to_rfc3339_opts(SecondsFormat::Secs, false)
}

pub fn today_iso() -> String {
    use chrono::Local;
    Local::now().format("%Y-%m-%d").to_string()
}

// Map a hide duration to its expiry date (ISO YYYY-MM-DD), or None for forever.
// day/week/month land on the start of a future local date — they auto-restore
// at the day-boundary sweep, consistent with the rest of DayApp's reset model.
pub fn hidden_until_for(duration: &str) -> Option<String> {
    use chrono::{Duration, Local, Months};
    let today = Local::now().date_naive();
    let date = match duration {
        "day" => Some(today + Duration::days(1)),
        "week" => Some(today + Duration::days(7)),
        "month" => Some(today.checked_add_months(Months::new(1))?),
        _ => None, // "forever" (or anything unknown) → never auto-restore
    };
    // checked_add_months can fail at the edge of the representable range; fall
    // back to a 30-day offset so a bad input never silently hides forever.
    let date = match (duration, date) {
        ("month", None) => today + Duration::days(30),
        (_, d) => d?,
    };
    Some(date.format("%Y-%m-%d").to_string())
}

// Build an Item from a 13-column SELECT row (id..priority).
fn item_from_row(r: &rusqlite::Row) -> rusqlite::Result<Item> {
    Ok(Item {
        id: r.get(0)?,
        text: r.get(1)?,
        section: r.get(2)?,
        status: r.get(3)?,
        last_completed_date: r.get(4)?,
        sort_order: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
        hidden: r.get::<_, i64>(8)? != 0,
        hidden_until: r.get(9)?,
        project_id: r.get(10)?,
        remind_at: r.get(11)?,
        priority: r.get(12)?,
    })
}

// Add a column only if it isn't already on the table. Lets schema.sql stay
// declarative for fresh DBs while still upgrading pre-existing ones.
fn ensure_column(
    conn: &Connection, table: &str, column: &str, decl: &str,
) -> anyhow::Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let present: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect();
    if !present.iter().any(|c| c == column) {
        log::info!("migrate: adding column {table}.{column} ({decl})");
        conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"), [])?;
    }
    Ok(())
}

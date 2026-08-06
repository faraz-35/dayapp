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
        Ok(())
    }

    // ---- Reads -----------------------------------------------------------

    /// All items in a section, ordered by sort_order. Optionally include done items.
    pub fn list(&self, section: &str, include_done: bool) -> anyhow::Result<Vec<Item>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = if include_done {
            conn.prepare(
                "SELECT id,text,section,status,last_completed_date,sort_order,created_at,updated_at
                 FROM items WHERE section = ?1 ORDER BY sort_order, created_at"
            )?
        } else {
            conn.prepare(
                "SELECT id,text,section,status,last_completed_date,sort_order,created_at,updated_at
                 FROM items WHERE section = ?1 AND status = 'active' ORDER BY sort_order, created_at"
            )?
        };
        let rows = stmt.query_map(params![section], |r| {
            Ok(Item {
                id: r.get(0)?,
                text: r.get(1)?,
                section: r.get(2)?,
                status: r.get(3)?,
                last_completed_date: r.get(4)?,
                sort_order: r.get(5)?,
                created_at: r.get(6)?,
                updated_at: r.get(7)?,
            })
        })?;
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
        let mut ids: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT id FROM items WHERE section = ?1 AND id != ?2 ORDER BY sort_order, created_at"
            )?;
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

        tx.commit()?;
        Ok(to_fall.len())
    }

    // ---- Log queries -----------------------------------------------------

    /// All actions in reverse-chronological order. This is the "journal".
    pub fn list_actions(&self, limit: Option<i64>) -> anyhow::Result<Vec<Action>> {
        let conn = self.0.lock().unwrap();
        let limit = limit.unwrap_or(500);
        let mut stmt = conn.prepare(
            "SELECT id,item_id,item_text,action,from_section,to_section,from_status,to_status,timestamp
             FROM actions ORDER BY id DESC LIMIT ?1")?;
        let rows = stmt.query_map(params![limit], |r| {
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

    /// Count completions in a date range. Powers the balls-in-the-box counter.
    pub fn count_completions(&self, since: &str) -> anyhow::Result<i64> {
        let conn = self.0.lock().unwrap();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM actions
             WHERE action = 'completed' AND timestamp >= ?1",
            params![since], |r| r.get(0))?;
        Ok(n)
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

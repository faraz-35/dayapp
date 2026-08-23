// Database layer: connection, schema init, typed Item/Action model.
// One SQLite file at ~/Library/Application Support/DayApp/dayapp.db.
//
// rusqlite is synchronous, so callers wrap DB work in
// `tauri::async_runtime::spawn_blocking` to keep the UI thread free.

use std::sync::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::timers::{finalize_open_session_for_item, finalize_retiring_today_sessions};

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
    pub assigned_to_agent: bool,      // delegation: 1 = fully delegable to an AI agent (housekeeping — not logged)
    pub details: String,              // free-form spec under the title; for agent rows, the prompt (content — not logged)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub id: i64,
    /// Set for item rows, null for goal rows (and vice versa for goal_id).
    pub item_id: Option<String>,
    pub goal_id: Option<String>,
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
//
// `conn` is the connection every command uses. Demo mode (see demo.rs) swaps
// the Connection inside that same mutex — real ↔ demo — so no command can
// observe a half-swapped state and none of them needs to know demo exists.
// The parked side stays open in `demo` for an instant swap back.
#[derive(Debug)]
pub struct Db {
    /// The ACTIVE connection — the real db's, or the demo db's while demo
    /// mode is on.
    pub conn: Mutex<Connection>,
    /// Demo-mode state behind its own lock (commands never touch it): the
    /// mode flag plus the inactive connection, parked while swapped.
    pub demo: Mutex<DemoSlot>,
    /// The real db's path — the demo file (dayapp-demo.db) is its sibling.
    pub real_path: std::path::PathBuf,
}

#[derive(Debug, Default)]
pub struct DemoSlot {
    /// Whether `Db::conn` currently holds the demo db.
    pub active: bool,
    /// The inactive connection (the real one while demo is on, the demo one
    /// while it's off). None when the other db was never opened.
    pub parked: Option<Connection>,
}

impl Db {
    pub fn open(path: &std::path::Path) -> anyhow::Result<Self> {
        let conn = Self::open_conn(path)?;
        Ok(Self {
            conn: Mutex::new(conn),
            demo: Mutex::new(DemoSlot::default()),
            real_path: path.to_path_buf(),
        })
    }

    /// Open a connection with DayApp's pragmas and schema migrations applied.
    /// Shared by the real db and the demo db — both must stay schema-identical,
    /// so migrations apply to either through the same path.
    pub(crate) fn open_conn(path: &std::path::Path) -> anyhow::Result<Connection> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        // The CLI (dayapp --list/--add/--complete) opens the same file while the
        // GUI is running — wait out each other's write locks instead of erroring.
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;     // crash-safe, fast
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Self::migrate(&conn)?;
        Ok(conn)
    }

    /// The launch sweep family: day-boundary sweep, done-today retirement,
    /// expired-hide restore, reminder promotion. Runs against whichever db is
    /// active — on every launch (real), and on every demo-mode toggle (each
    /// db behaves as if the app relaunched into it).
    pub fn launch_sweeps(&self) -> anyhow::Result<()> {
        let fell = self.run_sweep()?;
        if fell > 0 { log::info!("sweep: {fell} today item(s) fell to backlog"); }
        let purged = self.purge_completed_today()?;
        if purged > 0 { log::info!("sweep: {purged} completed today item(s) cleared"); }
        let ih = self.unhide_expired_items()?;
        let nh = self.unhide_expired_notes()?;
        if ih + nh > 0 { log::info!("unhide sweep: {ih} item(s), {nh} note(s) restored"); }
        let rp = self.promote_due_reminders()?;
        if rp > 0 { log::info!("reminders: {rp} backlog item(s) promoted to today"); }
        Ok(())
    }

    fn migrate(conn: &Connection) -> anyhow::Result<()> {
        // Actions v2: goals log here too (goal_* action values, a nullable
        // item_id + a goal_id column — see schema.sql). SQLite can't ALTER a
        // CHECK constraint or a NOT NULL, so detect the old shape and rebuild
        // the table once, copying the whole history through. This runs BEFORE
        // the schema batch below — schema.sql creates idx_actions_goal, which
        // can't run against the pre-goals table shape. On a fresh db there is
        // no actions table yet and the schema batch creates v2 directly.
        let actions_exists = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'actions'",
                [], |_| Ok(()),
            )
            .optional()?
            .is_some();
        if actions_exists {
            let has_goal_col = {
                let mut stmt = conn.prepare("SELECT name FROM pragma_table_info('actions')")?;
                let names: Vec<String> = stmt
                    .query_map([], |r| r.get::<_, String>(0))?
                    .filter_map(|n| n.ok())
                    .collect();
                names.iter().any(|n| n == "goal_id")
            };
            if !has_goal_col {
                log::info!("migrate: rebuilding actions table to add goal logging");
                // Keep this definition in lockstep with schema.sql's `actions`.
                conn.execute_batch("
                    BEGIN;
                    CREATE TABLE actions_v2 (
                        id           INTEGER PRIMARY KEY AUTOINCREMENT,
                        item_id      TEXT,
                        goal_id      TEXT,
                        item_text    TEXT NOT NULL,
                        action       TEXT NOT NULL CHECK (action IN
                                      ('created','completed','uncompleted','moved',
                                       'edited','deleted','fell_to_backlog',
                                       'goal_created','goal_achieved','goal_unachieved',
                                       'goal_edited','goal_deleted')),
                        from_section TEXT, to_section TEXT,
                        from_status  TEXT, to_status  TEXT,
                        timestamp    TEXT NOT NULL,
                        CHECK (item_id IS NOT NULL OR goal_id IS NOT NULL)
                    );
                    INSERT INTO actions_v2
                        (id,item_id,goal_id,item_text,action,from_section,to_section,from_status,to_status,timestamp)
                    SELECT id,item_id,NULL,item_text,action,from_section,to_section,from_status,to_status,timestamp
                    FROM actions;
                    DROP TABLE actions;
                    ALTER TABLE actions_v2 RENAME TO actions;
                    CREATE INDEX IF NOT EXISTS idx_actions_ts     ON actions(timestamp);
                    CREATE INDEX IF NOT EXISTS idx_actions_item   ON actions(item_id);
                    CREATE INDEX IF NOT EXISTS idx_actions_action ON actions(action);
                    CREATE INDEX IF NOT EXISTS idx_actions_goal   ON actions(goal_id);
                    COMMIT;
                ")?;
            }
        }

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
        ensure_column(conn, "items", "assigned_to_agent", "INTEGER NOT NULL DEFAULT 0")?;
        ensure_column(conn, "items", "details", "TEXT NOT NULL DEFAULT ''")?;
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
        let conn = self.conn.lock().unwrap();
        let mut sql = String::from(
            "SELECT id,text,section,status,last_completed_date,sort_order,created_at,updated_at,hidden,hidden_until,project_id,remind_at,priority,assigned_to_agent,details
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
        let conn = self.conn.lock().unwrap();
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
            assigned_to_agent: false, details: String::new(),
        })
    }

    pub fn edit_item(&self, id: &str, text: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
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

    /// Mark a non-daily item done. For a daily item, records completion for
    /// today; the item stays visible but greyed. A today item also stays —
    /// crossed out like a done daily — until the day-boundary sweep retires it;
    /// `last_completed_date` is what tells that sweep which completions belong
    /// to the current day (and keeps a same-day completion safe if the sweep
    /// has already run).
    ///
    /// If this item's timer is running, the open session is finalized inside
    /// the same transaction (kept in history). The rule lives here, not in the
    /// calling surface — the GUI's view of the active timer can be stale.
    pub fn complete_item(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let today = today_iso();
        let tx = conn.unchecked_transaction()?;

        let (text, section, status): (String, String, String) = tx.query_row(
            "SELECT text, section, status FROM items WHERE id = ?1", params![id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?;

        // Completing a running item stops its timer first — same transaction,
        // whichever surface asked for the completion.
        finalize_open_session_for_item(&tx, &now, id)?;

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
                "UPDATE items SET status = 'done', last_completed_date = ?1, updated_at = ?2 WHERE id = ?3",
                params![today, now, id])?;
            log_action(&tx, id, &text, "completed", Some(&section), Some(&section),
                       Some(&status), Some("done"), &now)?;
        }
        Ok(tx.commit()?)
    }

    /// Restore a completed today item to active — Enter or a checkbox click on
    /// a crossed row toggles it back. Logs `uncompleted`, the inverse of the
    /// completion entry, so the journal shows the correction.
    pub fn uncomplete_item(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let tx = conn.unchecked_transaction()?;
        let (text, section, status): (String, String, String) = tx.query_row(
            "SELECT text, section, status FROM items WHERE id = ?1", params![id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?;
        tx.execute(
            "UPDATE items SET status = 'active', last_completed_date = NULL, updated_at = ?1 WHERE id = ?2",
            params![now, id])?;
        log_action(&tx, id, &text, "uncompleted", Some(&section), Some(&section),
                   Some(&status), Some("active"), &now)?;
        Ok(tx.commit()?)
    }

    /// Move an item to a different section (drag, or programmatic).
    /// Re-indexes sort_order in the destination so it stays contiguous.
    pub fn move_item(&self, id: &str, to_section: &str, new_index: i64) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let tx = conn.unchecked_transaction()?;

        let (text, from_section): (String, String) = tx.query_row(
            "SELECT text, section FROM items WHERE id = ?1", params![id],
            |r| Ok((r.get(0)?, r.get(1)?)))?;

        if from_section != to_section {
            // Leaving the Backlog retires any pending reminder: a reminder's
            // whole job is "pull this row into Today on its date", and the row
            // has now been pulled — by drag, the Backlog's send-to-Today
            // button, or --move. The same clearing the sweep's promotion does,
            // enforced in the transaction so every surface gets it and a
            // reminder can never sit stale on a non-Backlog row
            // (promote_due_reminders only scans the Backlog).
            if from_section == "backlog" {
                tx.execute(
                    "UPDATE items SET section = ?1, remind_at = NULL, updated_at = ?2 WHERE id = ?3",
                    params![to_section, now, id])?;
            } else {
                tx.execute(
                    "UPDATE items SET section = ?1, updated_at = ?2 WHERE id = ?3",
                    params![to_section, now, id])?;
            }
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

    /// Delete an item. Any open session on it is finalized first, in the same
    /// transaction (the session is kept — its item_text snapshot survives the
    /// deletion, like actions), so a running timer can never outlive its row.
    pub fn delete_item(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let tx = conn.unchecked_transaction()?;
        let (text, section): (String, String) = tx.query_row(
            "SELECT text, section FROM items WHERE id = ?1", params![id],
            |r| Ok((r.get(0)?, r.get(1)?)))?;
        finalize_open_session_for_item(&tx, &now, id)?;
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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        conn.execute(
            "UPDATE items SET priority = ?1, updated_at = ?2 WHERE id = ?3",
            params![priority, now, id],
        )?;
        Ok(())
    }

    /// Assign an item to (or take it back from) the AI agent — the delegation
    /// axis, set via the `@` token. Housekeeping like priority — not logged.
    pub fn set_item_agent(&self, id: &str, assigned: bool) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        conn.execute(
            "UPDATE items SET assigned_to_agent = ?1, updated_at = ?2 WHERE id = ?3",
            params![assigned, now, id],
        )?;
        Ok(())
    }

    /// Set the item's details body — the spec under the one-line title; for
    /// agent-delegated rows, the prompt an autonomous session executes.
    /// Content like notes (not item-state): housekeeping, never logged.
    pub fn set_item_details(&self, id: &str, details: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        conn.execute(
            "UPDATE items SET details = ?1, updated_at = ?2 WHERE id = ?3",
            params![details, now, id],
        )?;
        Ok(())
    }

    /// Promote any backlog item whose reminder has come due (remind_at <= today)
    /// to Today, clearing remind_at so it fires once. Logged as a `moved`
    /// action — no new action enum, so the existing CHECK constraint is untouched.
    /// Idempotent (clearing remind_at prevents re-promotion). Called un-gated on
    /// launch and inside run_sweep (harmless to call twice).
    pub fn promote_due_reminders(&self) -> anyhow::Result<usize> {
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
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

        // Completed today items retire here — the cross has served its day and
        // the completion already lives in `actions`, so the row is deleted (a
        // NULL date means a pre-date-logging version wrote it; retire those
        // too). Rows dated today are kept: the sweep runs at a day boundary,
        // so a today-dated completion belongs to the fresh day.
        finalize_retiring_today_sessions(&tx, &now, &today)?;
        let purged = tx.execute(
            "DELETE FROM items
             WHERE section = 'today' AND status = 'done'
               AND (last_completed_date IS NULL OR last_completed_date != ?1)",
            params![today])?;

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
        if purged > 0 {
            log::info!("sweep: {purged} completed today item(s) cleared");
        }
        Ok(to_fall.len())
    }

    /// Delete completed today items from before today — the un-gated half of
    /// the sweep's retirement step. `run_sweep` does this when the day boundary
    /// actually opens; this standalone pass catches rows a gated-out sweep
    /// left behind (e.g. ones written by older versions on a day whose sweep
    /// already ran). Idempotent. Finalizes any still-open session on the
    /// retiring rows, same as the sweep.
    pub fn purge_completed_today(&self) -> anyhow::Result<usize> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let today = today_iso();
        let tx = conn.unchecked_transaction()?;
        finalize_retiring_today_sessions(&tx, &now, &today)?;
        let n = tx.execute(
            "DELETE FROM items
             WHERE section = 'today' AND status = 'done'
               AND (last_completed_date IS NULL OR last_completed_date != ?1)",
            params![today])?;
        tx.commit()?;
        Ok(n)
    }

    // ---- Meta ----------------------------------------------------------------
    // Generic key/value bag on the meta table (last_sweep_date, mobile-sync
    // config and guards). Sync-specific semantics live in sync.rs; these are
    // the raw accessors.

    pub fn meta_get(&self, key: &str) -> anyhow::Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let v = conn.query_row(
            "SELECT value FROM meta WHERE key = ?1", params![key], |r| r.get(0),
        ).optional()?;
        Ok(v)
    }

    pub fn meta_set(&self, key: &str, value: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO meta(key,value) VALUES(?1,?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value])?;
        Ok(())
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
        let conn = self.conn.lock().unwrap();
        let limit = limit.unwrap_or(500);

        // Build the WHERE clause dynamically so each bound is optional; collect
        // positional params in the same order so bind indices line up.
        let mut sql = String::from(
            "SELECT id,item_id,goal_id,item_text,action,from_section,to_section,from_status,to_status,timestamp
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
                id: r.get(0)?, item_id: r.get(1)?, goal_id: r.get(2)?,
                item_text: r.get(3)?, action: r.get(4)?,
                from_section: r.get(5)?, to_section: r.get(6)?,
                from_status: r.get(7)?, to_status: r.get(8)?, timestamp: r.get(9)?,
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

// Build an Item from a 15-column SELECT row (id..details).
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
        assigned_to_agent: r.get::<_, i64>(13)? != 0,
        details: r.get(14)?,
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

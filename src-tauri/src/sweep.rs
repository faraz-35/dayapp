// Sweeps — the no-cron engine: state plus a log that writes itself means
// "overnight" behaviours are just queries run at the right moment
// (launch + the frontend's 60s tick). The day-boundary sweep (6am) falls
// stale Today rows to Backlog and retires done rows; promote_due_reminders
// rides every sweep so a due reminder fires without a relaunch. Both are
// free fns on &Connection so run_sweep can call them without holding the
// Mutex (the launch path locks once). See AGENTS.md "Product philosophy".

use rusqlite::{params, Connection, OptionalExtension};
use crate::actions::log_action;
use crate::db::{now_iso, today_iso, Db};
use crate::timers::finalize_retiring_today_sessions;

impl Db {
    pub fn run_sweep(&self) -> anyhow::Result<usize> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let today = today_iso();

        let last_sweep: Option<String> = conn.query_row(
            "SELECT value FROM meta WHERE key = 'last_sweep_date'",
            [], |r| r.get(0)).optional()?;

        // The day-boundary work runs once per logical day; reminder promotion
        // rides every call, so a due reminder fires within a tick of its date
        // arriving — no relaunch needed. Promotion runs after the fall: a
        // just-promoted item belongs to the fresh day.
        let mut fell = 0;
        if last_sweep.as_deref() != Some(today.as_str()) {
            fell = day_boundary_sweep(&conn, &now, &today)?;
        }
        let promoted = promote_due_reminders(&conn)?;
        if promoted > 0 {
            log::info!("reminders: {promoted} backlog item(s) promoted to today");
        }
        Ok(fell)
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
}

/// The day-boundary half of run_sweep: today's survivors fall to backlog,
/// completed today items retire, expired hides auto-restore. Called by
/// run_sweep once per logical day — the meta.last_sweep_date gate lives there.
fn day_boundary_sweep(conn: &Connection, now: &str, today: &str) -> anyhow::Result<usize> {
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
    // (hidden_until <= today) for items, notes, and goals — time-limited
    // hides auto-restore here, no separate job. Each item/goal restore
    // logs `unpaused` (the pause window's close); notes have no journal
    // and stay unlogged.
    {
        let expiring: Vec<(String, String, String)> = {
            let mut stmt = tx.prepare(
                "SELECT id, text, section FROM items
                 WHERE hidden = 1 AND hidden_until IS NOT NULL AND hidden_until <= ?1")?;
            let rows = stmt.query_map(params![today], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
            })?;
            rows.filter_map(|r| r.ok()).collect()
        };
        for (id, text, section) in &expiring {
            tx.execute(
                "UPDATE items SET hidden = 0, hidden_until = NULL, updated_at = ?1 WHERE id = ?2",
                params![now, id],
            )?;
            log_action(&tx, id, text, "unpaused", Some(section), Some(section), None, None, &now)?;
        }
    }
    tx.execute(
        "UPDATE notes SET hidden = 0, hidden_until = NULL, updated_at = ?1
         WHERE hidden = 1 AND hidden_until IS NOT NULL AND hidden_until <= ?2",
        params![now, today])?;
    {
        let expiring: Vec<(String, String, String)> = {
            let mut stmt = tx.prepare(
                "SELECT id, text, horizon FROM goals
                 WHERE hidden = 1 AND hidden_until IS NOT NULL AND hidden_until <= ?1")?;
            let rows = stmt.query_map(params![today], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
            })?;
            rows.filter_map(|r| r.ok()).collect()
        };
        for (id, text, horizon) in &expiring {
            tx.execute(
                "UPDATE goals SET hidden = 0, hidden_until = NULL, updated_at = ?1 WHERE id = ?2",
                params![now, id],
            )?;
            crate::goals::log_goal_action(&tx, id, text, "unpaused",
                                          Some(horizon), Some(horizon), None, None, &now)?;
        }
    }

    tx.commit()?;
    if purged > 0 {
        log::info!("sweep: {purged} completed today item(s) cleared");
    }
    Ok(to_fall.len())
}

/// Promote any backlog item whose reminder has come due (remind_at <= today)
/// to Today, clearing remind_at so it fires once. Logged as a `moved` action —
/// no new action enum, so the existing CHECK constraint is untouched.
/// Idempotent (clearing remind_at prevents re-promotion). Rides every
/// run_sweep call — app startup and the frontend's 60s tick alike, so a due
/// reminder fires without a relaunch — after the day-boundary fall: a
/// promoted item belongs to the fresh day; ahead of the fall it would land
/// in today and fall straight back.

fn promote_due_reminders(conn: &Connection) -> anyhow::Result<usize> {
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

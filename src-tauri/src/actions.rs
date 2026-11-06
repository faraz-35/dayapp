// Actions — the journal every mutation writes itself. `log_action` snapshots
// the subject's text and organising axes (project/priority/agent) at write
// time inside the caller's transaction, so history survives edits and
// deletions — renaming a task never rewrites the past. Goals log through
// log_goal_action (goals.rs); both write exactly one subject column
// (CHECK-enforced).

use rusqlite::params;
use crate::db::{day_start_prefix, Db, Action};

impl Db {
    /// All actions in reverse-chronological order. This is the "journal".
    /// `since`/`until` are optional logical-day bounds (YYYY-MM-DD) — a
    /// half-open [since, until) range over the 6am→6am day, translated here
    /// to `T06:00:00` wall-clock prefixes and compared lexicographically
    /// against timestamp. NULL bounds are unbounded.
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
        if let Some(s) = since { sql.push_str(" AND timestamp >= ?"); pv.push(Box::new(day_start_prefix(s))); }
        if let Some(u) = until { sql.push_str(" AND timestamp < ?"); pv.push(Box::new(day_start_prefix(u))); }
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

pub(crate) fn log_action(
    tx: &rusqlite::Transaction,
    item_id: &str, item_text: &str, action: &str,
    from_section: Option<&str>, to_section: Option<&str>,
    from_status: Option<&str>, to_status: Option<&str>,
    timestamp: &str,
) -> anyhow::Result<()> {
    // The trailing subqueries snapshot the item's project NAME, priority tier,
    // and delegation flag at write time — the same deletion-proofing as
    // item_text, so the dashboard's splits read history that survives
    // reassignment. They read the live row, so callers must log while it still
    // exists (delete_item logs before its DELETE for exactly this reason).
    tx.execute(
        "INSERT INTO actions (item_id,item_text,action,from_section,to_section,from_status,to_status,timestamp,project,priority,agent)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,
                 (SELECT p.name FROM items i LEFT JOIN projects p ON p.id = i.project_id WHERE i.id = ?1),
                 (SELECT i.priority FROM items i WHERE i.id = ?1),
                 (SELECT i.assigned_to_agent FROM items i WHERE i.id = ?1))",
        params![item_id, item_text, action, from_section, to_section, from_status, to_status, timestamp])?;
    Ok(())
}

// ---- Time helpers. Local time, ISO strings. No tz complexity in v1. -------
// The day runs 06:00→06:00: working past midnight is still the previous day,
// so daily resets, sweeps, and every "today" comparison wait for the morning.

/// The hour the app's day flips. Matches lib.ts todayStr().
pub const DAY_START_HOUR: u32 = 6;

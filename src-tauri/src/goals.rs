// Goals module — the identity layer above the task sections: statements of
// direction at three horizons (short = months, long = years, timeless = a
// direction that never completes). Like items, goals are state + logged
// activity: every create/achieve/unachieve/edit/delete is wrapped in a
// transaction that also appends to `actions` (goal_* enum values; the horizon
// rides from/to_section, active/achieved rides from/to_status — the same
// columns, the same semantics, so the journal renders both uniformly).
// Project assignment is housekeeping — NOT logged, same as items.project_id.
//
// All methods hang off the shared `Db` struct. They touch the `goals` table
// and (for the journal) `actions`; deleting a project nulls goals.project_id —
// see projects.rs.

use crate::db::{hidden_until_for, now_iso, today_iso, HiddenFilter, Db};
use rusqlite::params;
use serde::{Deserialize, Serialize};

/// The three horizons, in display order (timeless first — it reads as
/// constitution → career → now). The CHECK constraint on the table enforces
/// the same set.
pub const HORIZONS: [&str; 3] = ["timeless", "long", "short"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    pub id: String,
    pub text: String,
    pub horizon: String,
    pub status: String,
    pub project_id: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
    pub achieved_at: Option<String>,
    pub hidden: bool,
    pub hidden_until: Option<String>,
}

fn goal_from_row(r: &rusqlite::Row) -> rusqlite::Result<Goal> {
    Ok(Goal {
        id: r.get(0)?,
        text: r.get(1)?,
        horizon: r.get(2)?,
        status: r.get(3)?,
        project_id: r.get(4)?,
        sort_order: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
        achieved_at: r.get(8)?,
        hidden: r.get::<_, i64>(9)? != 0,
        hidden_until: r.get(10)?,
    })
}

/// Append a goal's journal entry. Mirrors `log_action` in db.rs: the goal's
/// text is snapshotted at write time, the horizon rides the section columns,
/// and active/achieved rides the status columns. The project NAME is
/// snapshotted too (goals carry no priority) — the subquery reads the live
/// row, so delete_goal logs before its DELETE. `pub` because the day-boundary
/// sweep in db.rs resumes expired pauses and logs their close through this.
#[allow(clippy::too_many_arguments)]
pub fn log_goal_action(
    tx: &rusqlite::Transaction,
    goal_id: &str, goal_text: &str, action: &str,
    from_horizon: Option<&str>, to_horizon: Option<&str>,
    from_status: Option<&str>, to_status: Option<&str>,
    timestamp: &str,
) -> anyhow::Result<()> {
    tx.execute(
        "INSERT INTO actions (goal_id,item_text,action,from_section,to_section,from_status,to_status,timestamp,project)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,
                 (SELECT p.name FROM goals g LEFT JOIN projects p ON p.id = g.project_id WHERE g.id = ?1))",
        params![goal_id, goal_text, action, from_horizon, to_horizon, from_status, to_status, timestamp])?;
    Ok(())
}

impl Db {
    // ---- Goals ------------------------------------------------------------

    /// All goals in manual order. Grouping by horizon (and moving achieved to
    /// the end) is a display concern — the frontend groups, and the CLI sorts
    /// with `HORIZONS`. `hidden` picks the visibility mode: Exclude (default)
    /// keeps paused rows out, Include is the ⌘P reveal (they render inline,
    /// dimmed, in their horizon group — the hidden-task render).
    pub fn list_goals(&self, hidden: HiddenFilter) -> anyhow::Result<Vec<Goal>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = String::from(
            "SELECT id, text, horizon, status, project_id, sort_order, created_at, updated_at, achieved_at, hidden, hidden_until
             FROM goals WHERE 1=1",
        );
        sql.push_str(hidden.clause());
        sql.push_str(" ORDER BY sort_order, created_at");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], goal_from_row)?;
        let mut out = Vec::new();
        for r in rows { out.push(r?); }
        Ok(out)
    }

    /// Create a goal at the bottom of the list. `horizon` must be
    /// short | long | timeless (the frontend defaults a bare capture to short).
    pub fn create_goal(
        &self, text: &str, horizon: &str, project_id: Option<&str>,
    ) -> anyhow::Result<Goal> {
        if !HORIZONS.contains(&horizon) {
            anyhow::bail!("horizon must be short, long, or timeless (got \"{horizon}\")");
        }
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let id = ulid::Ulid::new().to_string();
        let max_order: i64 = conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) FROM goals",
            [], |r| r.get(0),
        )?;
        let sort_order = max_order + 1;

        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO goals (id, text, horizon, status, project_id, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?6, ?6)",
            params![id, text, horizon, project_id, sort_order, now],
        )?;
        log_goal_action(&tx, &id, text, "goal_created", None, Some(horizon), None, Some("active"), &now)?;
        tx.commit()?;

        Ok(Goal {
            id, text: text.to_string(), horizon: horizon.to_string(), status: "active".into(),
            project_id: project_id.map(str::to_string), sort_order,
            created_at: now.clone(), updated_at: now, achieved_at: None,
            hidden: false, hidden_until: None,
        })
    }

    /// Edit a goal's text. `horizon = Some(_)` moves it between groups; None
    /// leaves the horizon alone (the "no token on edit changes nothing" rule
    /// shared with the `#tag`/`!N` item tokens). Logs `goal_edited` when the
    /// text or the horizon actually changed — a horizon change shows as the
    /// from/to pair, like a section move.
    pub fn edit_goal(&self, id: &str, text: &str, horizon: Option<&str>) -> anyhow::Result<()> {
        if let Some(h) = horizon {
            if !HORIZONS.contains(&h) {
                anyhow::bail!("horizon must be short, long, or timeless (got \"{h}\")");
            }
        }
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let tx = conn.unchecked_transaction()?;
        let (old_text, old_horizon): (String, String) = tx.query_row(
            "SELECT text, horizon FROM goals WHERE id = ?1", params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).map_err(|e| anyhow::anyhow!("no goal {id}: {e}"))?;
        tx.execute(
            "UPDATE goals SET text = ?1, horizon = COALESCE(?2, horizon), updated_at = ?3 WHERE id = ?4",
            params![text, horizon, now, id],
        )?;
        let new_horizon = horizon.unwrap_or(old_horizon.as_str());
        // Only log if something actually changed; keeps the journal clean.
        if old_text != text || old_horizon != new_horizon {
            log_goal_action(&tx, id, text, "goal_edited",
                            Some(&old_horizon), Some(new_horizon), None, None, &now)?;
        }
        Ok(tx.commit()?)
    }

    /// Move a goal to another horizon (the drag) or reorder within one. A
    /// cross-horizon move logs `goal_edited` with the from/to horizon pair —
    /// the same journal entry the leading-word edit writes, so no new action
    /// verb and the actions CHECK stays untouched; a same-horizon reorder is
    /// unlogged, like a same-section task reorder. Re-indexes the
    /// destination horizon's visible (active, un-paused) rows to 0..N so
    /// sort_order stays contiguous there — the frontend's drop index counts
    /// that same group.
    pub fn move_goal(&self, id: &str, to_horizon: &str, new_index: i64) -> anyhow::Result<()> {
        if !HORIZONS.contains(&to_horizon) {
            anyhow::bail!("horizon must be short, long, or timeless (got \"{to_horizon}\")");
        }
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let tx = conn.unchecked_transaction()?;
        let (text, from_horizon): (String, String) = tx.query_row(
            "SELECT text, horizon FROM goals WHERE id = ?1", params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).map_err(|e| anyhow::anyhow!("no goal {id}: {e}"))?;

        if from_horizon != to_horizon {
            tx.execute(
                "UPDATE goals SET horizon = ?1, updated_at = ?2 WHERE id = ?3",
                params![to_horizon, now, id],
            )?;
            log_goal_action(&tx, id, &text, "goal_edited",
                            Some(&from_horizon), Some(to_horizon), None, None, &now)?;
        }

        let mut ids: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT id FROM goals
                 WHERE horizon = ?1 AND status = 'active' AND hidden = 0 AND id != ?2
                 ORDER BY sort_order, created_at",
            )?;
            let rows = stmt.query_map(params![to_horizon, id], |r| r.get::<_, String>(0))?;
            let mut v = Vec::new();
            for r in rows { v.push(r?); }
            v
        };
        let insert_at = (new_index as usize).min(ids.len());
        ids.insert(insert_at, id.to_string());
        for (i, row_id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE goals SET sort_order = ?1 WHERE id = ?2",
                params![i as i64, row_id],
            )?;
        }
        Ok(tx.commit()?)
    }

    /// Assign (or clear) a goal's project. Housekeeping — not logged.
    pub fn set_goal_project(
        &self, id: &str, project_id: Option<&str>,
    ) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        conn.execute(
            "UPDATE goals SET project_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![project_id, now, id],
        )?;
        Ok(())
    }

    /// Mark a goal achieved. Short/long only — a timeless goal is a direction,
    /// not a destination; it can only be revised or deleted.
    pub fn achieve_goal(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let tx = conn.unchecked_transaction()?;
        let (text, horizon, status): (String, String, String) = tx.query_row(
            "SELECT text, horizon, status FROM goals WHERE id = ?1", params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).map_err(|e| anyhow::anyhow!("no goal {id}: {e}"))?;
        if horizon == "timeless" {
            anyhow::bail!("a timeless goal can't be achieved — revise or delete it instead");
        }
        tx.execute(
            "UPDATE goals SET status = 'achieved', achieved_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![now, id],
        )?;
        log_goal_action(&tx, id, &text, "goal_achieved",
                        Some(&horizon), Some(&horizon), Some(&status), Some("achieved"), &now)?;
        Ok(tx.commit()?)
    }

    /// Undo an achievement: back to active, achieved_at cleared. Logs
    /// `goal_unachieved`, the inverse entry — the journal shows the correction.
    pub fn unachieve_goal(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let tx = conn.unchecked_transaction()?;
        let (text, horizon, status): (String, String, String) = tx.query_row(
            "SELECT text, horizon, status FROM goals WHERE id = ?1", params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).map_err(|e| anyhow::anyhow!("no goal {id}: {e}"))?;
        tx.execute(
            "UPDATE goals SET status = 'active', achieved_at = NULL, updated_at = ?1 WHERE id = ?2",
            params![now, id],
        )?;
        log_goal_action(&tx, id, &text, "goal_unachieved",
                        Some(&horizon), Some(&horizon), Some(&status), Some("active"), &now)?;
        Ok(tx.commit()?)
    }

    /// Delete a goal outright (the timeless "this no longer resonates" exit).
    pub fn delete_goal(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let tx = conn.unchecked_transaction()?;
        let (text, horizon): (String, String) = tx.query_row(
            "SELECT text, horizon FROM goals WHERE id = ?1", params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).map_err(|e| anyhow::anyhow!("no goal {id}: {e}"))?;
        // Log while the row still exists — the project snapshot subquery in
        // log_goal_action reads the live goal.
        log_goal_action(&tx, id, &text, "goal_deleted", Some(&horizon), None, None, None, &now)?;
        tx.execute("DELETE FROM goals WHERE id = ?1", params![id])?;
        Ok(tx.commit()?)
    }

    // ---- Pause (hide) -----------------------------------------------------
    //
    // Soft-archive, the same mechanism items and notes carry: the row stays
    // in `goals` so it can be resumed, but `list_goals`' default filter
    // excludes it. `hidden_until` is NULL for "forever", else an ISO date at
    // which `unhide_expired_goals` (the day-boundary sweep) resumes it. The
    // flag is the display mechanism; `paused`/`unpaused` actions are its
    // dated record — goal rows log under the same verbs items use, so the
    // CHECK constraint and the journal's renderer are untouched.

    /// Pause a goal. `duration` is one of: forever | day | week | month.
    pub fn pause_goal(&self, id: &str, duration: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let hidden_until = hidden_until_for(duration);
        let tx = conn.unchecked_transaction()?;
        let (text, horizon): (String, String) = tx.query_row(
            "SELECT text, horizon FROM goals WHERE id = ?1", params![id],
            |r| Ok((r.get(0)?, r.get(1)?)))?;
        tx.execute(
            "UPDATE goals SET hidden = 1, hidden_until = ?1, updated_at = ?2 WHERE id = ?3",
            params![hidden_until, now, id],
        )?;
        log_goal_action(&tx, id, &text, "paused", Some(&horizon), Some(&horizon), None, None, &now)?;
        Ok(tx.commit()?)
    }

    /// Resume a paused goal — clears both the flag and the expiry.
    pub fn resume_goal(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let tx = conn.unchecked_transaction()?;
        let (text, horizon): (String, String) = tx.query_row(
            "SELECT text, horizon FROM goals WHERE id = ?1", params![id],
            |r| Ok((r.get(0)?, r.get(1)?)))?;
        tx.execute(
            "UPDATE goals SET hidden = 0, hidden_until = NULL, updated_at = ?1 WHERE id = ?2",
            params![now, id],
        )?;
        log_goal_action(&tx, id, &text, "unpaused", Some(&horizon), Some(&horizon), None, None, &now)?;
        Ok(tx.commit()?)
    }

    /// Clear the paused flag on any goal whose time-limited pause has
    /// expired. Called by the launch sweep, so pauses auto-resume at the day
    /// boundary without a cron job. Each resume logs `unpaused` — the pause
    /// window's close. Idempotent. Returns the number of goals resumed.
    pub fn unhide_expired_goals(&self) -> anyhow::Result<usize> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let today = today_iso();
        let tx = conn.unchecked_transaction()?;
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
            log_goal_action(&tx, id, text, "unpaused", Some(horizon), Some(horizon), None, None, &now)?;
        }
        tx.commit()?;
        Ok(expiring.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("dayapp-test-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn goal_lifecycle_logs_actions() {
        let dir = tmp_dir();
        let db = Db::open(&dir.join("t.db")).unwrap();
        let g = db.create_goal("get a job", "short", None).unwrap();
        db.achieve_goal(&g.id).unwrap();
        db.unachieve_goal(&g.id).unwrap();
        db.edit_goal(&g.id, "get a great job", Some("long")).unwrap();
        db.delete_goal(&g.id).unwrap();
        assert!(db.list_goals(HiddenFilter::Exclude).unwrap().is_empty());

        let log = db.list_actions(None, None, None).unwrap();
        let verbs: Vec<&str> = log.iter().map(|a| a.action.as_str()).collect();
        assert_eq!(
            verbs,
            ["goal_deleted", "goal_edited", "goal_unachieved", "goal_achieved", "goal_created"]
        );
        for a in &log {
            assert!(a.item_id.is_none(), "goal rows must not set item_id");
            assert_eq!(a.goal_id.as_deref(), Some(g.id.as_str()));
        }
        // A horizon move shows as the from/to pair, like a section move.
        let edited = log.iter().find(|a| a.action == "goal_edited").unwrap();
        assert_eq!(edited.from_section.as_deref(), Some("short"));
        assert_eq!(edited.to_section.as_deref(), Some("long"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn timeless_goals_cannot_be_achieved() {
        let dir = tmp_dir();
        let db = Db::open(&dir.join("t.db")).unwrap();
        let g = db.create_goal("be a better person", "timeless", None).unwrap();
        assert!(db.achieve_goal(&g.id).is_err());
        // The rejected achieve must not have logged anything beyond the create.
        let log = db.list_actions(None, None, None).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].action, "goal_created");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Pause/resume rides the shared paused/unpaused verbs (goal_id on the
    /// log rows), and the default list excludes paused rows while the reveal
    /// keeps them in place.
    #[test]
    fn goal_pause_roundtrip() {
        let dir = tmp_dir();
        let db = Db::open(&dir.join("t.db")).unwrap();
        let g = db.create_goal("learn rust", "short", None).unwrap();
        db.pause_goal(&g.id, "forever").unwrap();
        assert!(db.list_goals(HiddenFilter::Exclude).unwrap().is_empty());
        let shown = db.list_goals(HiddenFilter::Include).unwrap();
        assert_eq!(shown.len(), 1);
        assert!(shown[0].hidden);
        assert!(shown[0].hidden_until.is_none());
        db.resume_goal(&g.id).unwrap();
        assert_eq!(db.list_goals(HiddenFilter::Exclude).unwrap().len(), 1);
        // The log carries the goal-subject pause window under the shared verbs.
        let log = db.list_actions(None, None, None).unwrap();
        let verbs: Vec<&str> = log.iter().map(|a| a.action.as_str()).collect();
        assert_eq!(verbs, ["unpaused", "paused", "goal_created"]);
        assert!(log.iter().all(|a| a.goal_id.as_deref() == Some(g.id.as_str())));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The drag: a cross-horizon move rewrites the horizon and logs the
    /// goal_edited from/to pair (the leading-word edit's entry); a
    /// same-horizon reorder re-indexes silently. Paused rows don't take part
    /// in the destination's ordering.
    #[test]
    fn goal_move_moves_and_reindexes() {
        let dir = tmp_dir();
        let db = Db::open(&dir.join("t.db")).unwrap();
        let a = db.create_goal("a", "short", None).unwrap();
        let b = db.create_goal("b", "short", None).unwrap();
        let c = db.create_goal("c", "long", None).unwrap();

        // Reorder within short: b to the front, unlogged.
        db.move_goal(&b.id, "short", 0).unwrap();
        let short = |db: &Db| -> Vec<String> {
            db.list_goals(HiddenFilter::Exclude).unwrap()
                .into_iter().filter(|g| g.horizon == "short")
                .map(|g| g.text).collect()
        };
        assert_eq!(short(&db), ["b", "a"]);
        assert_eq!(db.list_actions(None, None, None).unwrap().len(), 3);

        // Drag a across the seam: horizon flips, the journal shows the pair.
        db.move_goal(&a.id, "long", 0).unwrap();
        assert_eq!(short(&db), ["b"]);
        let long: Vec<String> = db.list_goals(HiddenFilter::Exclude).unwrap()
            .into_iter().filter(|g| g.horizon == "long").map(|g| g.text).collect();
        assert_eq!(long, ["a", "c"]);
        let moved = db.list_actions(None, None, None).unwrap()
            .into_iter().find(|a| a.action == "goal_edited").unwrap();
        assert_eq!(moved.from_section.as_deref(), Some("short"));
        assert_eq!(moved.to_section.as_deref(), Some("long"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Pre-goals databases have the v1 `actions` shape (NOT NULL item_id, no
    /// goal_id, no goal_* enum values). Opening one must rebuild the table —
    /// copying the whole history through — and goal logging must work on it.
    #[test]
    fn actions_v1_history_survives_the_goal_migration() {
        let dir = tmp_dir();
        let path = dir.join("t.db");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE actions (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    item_id      TEXT NOT NULL,
                    item_text    TEXT NOT NULL,
                    action       TEXT NOT NULL CHECK (action IN
                                  ('created','completed','uncompleted','moved',
                                   'edited','deleted','fell_to_backlog')),
                    from_section TEXT, to_section TEXT,
                    from_status  TEXT, to_status  TEXT,
                    timestamp    TEXT NOT NULL);
                 INSERT INTO actions (item_id,item_text,action,timestamp) VALUES
                   ('01J','old task','created','2026-01-01T09:00:00'),
                   ('01J','old task','completed','2026-01-01T10:00:00');",
            )
            .unwrap();
        }
        let db = Db::open(&path).unwrap();
        let log = db.list_actions(None, None, None).unwrap();
        assert_eq!(log.len(), 2, "history must survive the rebuild");
        assert_eq!(log[0].action, "completed");
        assert_eq!(log[0].item_id.as_deref(), Some("01J"));
        assert!(log[0].goal_id.is_none());
        // And goal logging works on the migrated table.
        let g = db.create_goal("get a job", "short", None).unwrap();
        db.achieve_goal(&g.id).unwrap();
        let log = db.list_actions(None, None, None).unwrap();
        assert_eq!(log[0].action, "goal_achieved");
        assert_eq!(log[0].goal_id.as_deref(), Some(g.id.as_str()));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// Goals module — the identity layer above the task sections: statements of
// direction at three horizons (short = months, long = years, timeless = a
// direction that never completes). Goals are content, not activity — like
// notes/projects they are NOT logged to `actions`; the lifecycle dates
// (created_at / achieved_at) live on the row itself, which is what the planned
// read-only agent bridge reads.
//
// All methods hang off the shared `Db` struct. They touch the `goals` table
// only (project assignment is goals.project_id; deleting a project nulls it —
// see projects.rs).

use crate::db::{now_iso, Db};
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
    })
}

impl Db {
    // ---- Goals ------------------------------------------------------------

    /// All goals in manual order. Grouping by horizon (and moving achieved to
    /// the end) is a display concern — the frontend groups, and the CLI sorts
    /// with `HORIZONS`.
    pub fn list_goals(&self) -> anyhow::Result<Vec<Goal>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, text, horizon, status, project_id, sort_order, created_at, updated_at, achieved_at
             FROM goals ORDER BY sort_order, created_at",
        )?;
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
        let conn = self.0.lock().unwrap();
        let now = now_iso();
        let id = ulid::Ulid::new().to_string();
        let max_order: i64 = conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) FROM goals",
            [], |r| r.get(0),
        )?;
        let sort_order = max_order + 1;

        conn.execute(
            "INSERT INTO goals (id, text, horizon, status, project_id, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?6, ?6)",
            params![id, text, horizon, project_id, sort_order, now],
        )?;

        Ok(Goal {
            id, text: text.to_string(), horizon: horizon.to_string(), status: "active".into(),
            project_id: project_id.map(str::to_string), sort_order,
            created_at: now.clone(), updated_at: now, achieved_at: None,
        })
    }

    /// Edit a goal's text. `horizon = Some(_)` moves it between groups; None
    /// leaves the horizon alone (the "no token on edit changes nothing" rule
    /// shared with the `#tag`/`!N` item tokens).
    pub fn edit_goal(&self, id: &str, text: &str, horizon: Option<&str>) -> anyhow::Result<()> {
        if let Some(h) = horizon {
            if !HORIZONS.contains(&h) {
                anyhow::bail!("horizon must be short, long, or timeless (got \"{h}\")");
            }
        }
        let conn = self.0.lock().unwrap();
        let now = now_iso();
        conn.execute(
            "UPDATE goals SET text = ?1, horizon = COALESCE(?2, horizon), updated_at = ?3 WHERE id = ?4",
            params![text, horizon, now, id],
        )?;
        Ok(())
    }

    /// Assign (or clear) a goal's project. Housekeeping — not logged.
    pub fn set_goal_project(
        &self, id: &str, project_id: Option<&str>,
    ) -> anyhow::Result<()> {
        let conn = self.0.lock().unwrap();
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
        let conn = self.0.lock().unwrap();
        let horizon: String = conn.query_row(
            "SELECT horizon FROM goals WHERE id = ?1",
            params![id], |r| r.get(0),
        ).map_err(|e| anyhow::anyhow!("no goal {id}: {e}"))?;
        if horizon == "timeless" {
            anyhow::bail!("a timeless goal can't be achieved — revise or delete it instead");
        }
        let now = now_iso();
        conn.execute(
            "UPDATE goals SET status = 'achieved', achieved_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![now, id],
        )?;
        Ok(())
    }

    /// Undo an achievement: back to active, achieved_at cleared.
    pub fn unachieve_goal(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.0.lock().unwrap();
        let now = now_iso();
        conn.execute(
            "UPDATE goals SET status = 'active', achieved_at = NULL, updated_at = ?1 WHERE id = ?2",
            params![now, id],
        )?;
        Ok(())
    }

    /// Delete a goal outright (the timeless "this no longer resonates" exit).
    pub fn delete_goal(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.0.lock().unwrap();
        conn.execute("DELETE FROM goals WHERE id = ?1", params![id])?;
        Ok(())
    }
}

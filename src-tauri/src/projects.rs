// Projects module — a second organising axis alongside Sections.
// Deliberately not logged to `actions`: assigning an item to a project is
// housekeeping (like hide), so the journal stays focused on completion/movement.
//
// All methods hang off the shared `Db` struct. They touch the `projects` table
// and (for assignment) `items.project_id` — nothing else.

use crate::db::{now_iso, Db};
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
    pub created_at: String,
}

impl Db {
    // ---- Projects --------------------------------------------------------

    /// All projects ordered by sort_order, then created_at.
    pub fn list_projects(&self) -> anyhow::Result<Vec<Project>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, sort_order, created_at
             FROM projects ORDER BY sort_order, created_at",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Project {
                id: r.get(0)?,
                name: r.get(1)?,
                sort_order: r.get(2)?,
                created_at: r.get(3)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows { out.push(r?); }
        Ok(out)
    }

    /// Create a project at the bottom of the list. Returns the new project.
    pub fn create_project(&self, name: &str) -> anyhow::Result<Project> {
        let conn = self.0.lock().unwrap();
        let now = now_iso();
        let id = ulid::Ulid::new().to_string();
        let max_order: i64 = conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) FROM projects",
            [], |r| r.get(0),
        )?;
        let sort_order = max_order + 1;

        conn.execute(
            "INSERT INTO projects (id, name, sort_order, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![id, name, sort_order, now],
        )?;

        Ok(Project { id, name: name.to_string(), sort_order, created_at: now })
    }

    /// Rename a project in place.
    pub fn rename_project(&self, id: &str, name: &str) -> anyhow::Result<()> {
        let conn = self.0.lock().unwrap();
        conn.execute(
            "UPDATE projects SET name = ?1 WHERE id = ?2",
            params![name, id],
        )?;
        Ok(())
    }

    /// Delete a project and null the assignment on any items that referenced it.
    /// The items themselves are kept. Not logged to actions (housekeeping).
    pub fn delete_project(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.0.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
        tx.execute(
            "UPDATE items SET project_id = NULL WHERE project_id = ?1",
            params![id],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Assign (or clear) an item's project. `project_id = None` unassigns.
    /// Housekeeping — not logged to actions.
    pub fn set_item_project(
        &self, item_id: &str, project_id: Option<&str>,
    ) -> anyhow::Result<()> {
        let conn = self.0.lock().unwrap();
        let now = now_iso();
        conn.execute(
            "UPDATE items SET project_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![project_id, now, item_id],
        )?;
        Ok(())
    }
}

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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        insert_project(&conn, name)
    }

    /// Rename a project in place.
    pub fn rename_project(&self, id: &str, name: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE projects SET name = ?1 WHERE id = ?2",
            params![name, id],
        )?;
        Ok(())
    }

    /// Delete a project and null the assignment on any items/goals/notes that
    /// referenced it. The rows themselves are kept. Not logged to actions
    /// (housekeeping). Note: a note whose body still ends with a `#tag` footer
    /// re-resolves the tag on its next save — an unmatched tag recreates the
    /// project (the same create-on-capture rule items' trailing tags follow);
    /// deleting the tag from the body is what drops the link for good.
    pub fn delete_project(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
        tx.execute(
            "UPDATE items SET project_id = NULL WHERE project_id = ?1",
            params![id],
        )?;
        tx.execute(
            "UPDATE goals SET project_id = NULL WHERE project_id = ?1",
            params![id],
        )?;
        tx.execute(
            "UPDATE notes SET project_id = NULL WHERE project_id = ?1",
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
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        conn.execute(
            "UPDATE items SET project_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![project_id, now, item_id],
        )?;
        Ok(())
    }
}

/// The conn-level INSERT shared by `create_project` (the command path) and
/// `resolve_or_create_project` (note-footer derivation, which runs while the
/// connection lock is already held by the note write).
fn insert_project(conn: &rusqlite::Connection, name: &str) -> anyhow::Result<Project> {
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

/// Resolve a `#tag` to a project id with exactly the semantics the frontend's
/// `parseProjectTag` gives item capture text (lib.ts): case-insensitive exact
/// name match, else a *unique* case-insensitive name prefix; an unmatched tag
/// creates a brand-new project named verbatim after it — the footer's tag sits
/// at the end of its line by construction, so it always satisfies the
/// "trailing tag may create" rule. Used by note-footer derivation, so it takes
/// the raw connection (the caller holds the lock).
pub(crate) fn resolve_or_create_project(
    conn: &rusqlite::Connection, tag: &str,
) -> anyhow::Result<String> {
    let lower = tag.to_lowercase();
    let mut stmt = conn.prepare("SELECT id, name FROM projects")?;
    let rows: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();
    if let Some((id, _)) = rows.iter().find(|(_, name)| name.to_lowercase() == lower) {
        return Ok(id.clone());
    }
    let prefixes: Vec<&(String, String)> =
        rows.iter().filter(|(_, name)| name.to_lowercase().starts_with(&lower)).collect();
    if prefixes.len() == 1 {
        return Ok(prefixes[0].0.clone());
    }
    // No match, or an ambiguous prefix — the tag creates its own project,
    // same as a trailing unmatched `#tag` on an item.
    Ok(insert_project(conn, tag)?.id)
}

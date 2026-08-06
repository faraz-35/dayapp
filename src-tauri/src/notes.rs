// Notes module — free-form multiline text (quotes, scratch, paste).
// Deliberately separate from items/actions: notes are *content*, not activity,
// so they have their own table and are never logged to the journal.
//
// All methods hang off the shared `Db` struct but touch only the `notes` table,
// keeping the two feature areas decoupled at the storage layer.

use crate::db::{now_iso, Db};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub body: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

impl Db {
    // ---- Notes ------------------------------------------------------------

    /// All notes ordered by sort_order. Empty body notes are kept (a fresh
    /// note is the zero-inertia landing surface on first paint).
    pub fn list_notes(&self) -> anyhow::Result<Vec<Note>> {
        let conn = self.0.lock().unwrap();
        list_notes_inner(&conn)
    }

    /// Create a new empty note at the bottom of the list. Returns the new note.
    pub fn create_note(&self) -> anyhow::Result<Note> {
        let conn = self.0.lock().unwrap();
        let now = now_iso();
        let id = ulid::Ulid::new().to_string();
        let max_order: i64 = conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) FROM notes",
            [], |r| r.get(0),
        )?;
        let sort_order = max_order + 1;

        conn.execute(
            "INSERT INTO notes (id, body, sort_order, created_at, updated_at)
             VALUES (?1, '', ?2, ?3, ?3)",
            params![id, sort_order, now],
        )?;

        Ok(Note {
            id,
            body: String::new(),
            sort_order,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    /// Update a note's body. No journal entry — notes aren't activity.
    pub fn update_note(&self, id: &str, body: &str) -> anyhow::Result<()> {
        let conn = self.0.lock().unwrap();
        let now = now_iso();
        conn.execute(
            "UPDATE notes SET body = ?1, updated_at = ?2 WHERE id = ?3",
            params![body, now, id],
        )?;
        Ok(())
    }

    pub fn delete_note(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.0.lock().unwrap();
        conn.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Ensure at least one note exists. Called on startup so the user always
    /// has a ready textarea — zero inertia to write a note.
    pub fn ensure_seed_note(&self) -> anyhow::Result<()> {
        let conn = self.0.lock().unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))?;
        if count == 0 {
            let now = now_iso();
            let id = ulid::Ulid::new().to_string();
            conn.execute(
                "INSERT INTO notes (id, body, sort_order, created_at, updated_at)
                 VALUES (?1, '', 0, ?2, ?2)",
                params![id, now],
            )?;
        }
        Ok(())
    }
}

fn list_notes_inner(conn: &Connection) -> anyhow::Result<Vec<Note>> {
    let mut stmt = conn.prepare(
        "SELECT id, body, sort_order, created_at, updated_at
         FROM notes ORDER BY sort_order, created_at",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Note {
            id: r.get(0)?,
            body: r.get(1)?,
            sort_order: r.get(2)?,
            created_at: r.get(3)?,
            updated_at: r.get(4)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

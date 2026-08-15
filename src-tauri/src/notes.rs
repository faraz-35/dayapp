// Notes module — free-form multiline text (quotes, scratch, paste).
// Deliberately separate from items/actions: notes are *content*, not activity,
// so they have their own table and are never logged to the journal.
//
// All methods hang off the shared `Db` struct but touch only the `notes` table,
// keeping the two feature areas decoupled at the storage layer.

use crate::db::{now_iso, hidden_until_for, HiddenFilter, Db};
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
    pub hidden: bool,
    pub hidden_until: Option<String>,
}

impl Db {
    // ---- Notes ------------------------------------------------------------

    /// All notes ordered by sort_order. `hidden` picks the ⌘P visibility mode —
    /// Include/Only render archived notes inline in the notes list.
    pub fn list_notes(&self, hidden: HiddenFilter) -> anyhow::Result<Vec<Note>> {
        let conn = self.0.lock().unwrap();
        list_notes_inner(&conn, hidden)
    }

    /// Create a new note with the given body at the bottom of the list.
    pub fn create_note(&self, body: &str) -> anyhow::Result<Note> {
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
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id, body, sort_order, now],
        )?;

        Ok(Note {
            id,
            body: body.to_string(),
            sort_order,
            created_at: now.clone(),
            updated_at: now,
            hidden: false,
            hidden_until: None,
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

    // ---- Hide ------------------------------------------------------------
    //
    // Same soft-archive model as items: hidden=1 keeps the row so it can be
    // unhidden, but `list_notes` filters it out. hidden_until NULL = forever,
    // else an ISO date cleared by the day-boundary sweep. Not logged — notes
    // are content, not activity (see notes.rs module header).

    pub fn hide_note(&self, id: &str, duration: &str) -> anyhow::Result<()> {
        let conn = self.0.lock().unwrap();
        let now = now_iso();
        let hidden_until = hidden_until_for(duration);
        conn.execute(
            "UPDATE notes SET hidden = 1, hidden_until = ?1, updated_at = ?2 WHERE id = ?3",
            params![hidden_until, now, id],
        )?;
        Ok(())
    }

    pub fn unhide_note(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.0.lock().unwrap();
        let now = now_iso();
        conn.execute(
            "UPDATE notes SET hidden = 0, hidden_until = NULL, updated_at = ?1 WHERE id = ?2",
            params![now, id],
        )?;
        Ok(())
    }

    /// Clear expired time-limited hides. (Also done inline by run_sweep on the
    /// day boundary; this is the standalone path called on launch.) Returns the
    /// number of rows restored.
    pub fn unhide_expired_notes(&self) -> anyhow::Result<usize> {
        let conn = self.0.lock().unwrap();
        let now = now_iso();
        let today = crate::db::today_iso();
        let n = conn.execute(
            "UPDATE notes SET hidden = 0, hidden_until = NULL, updated_at = ?1
             WHERE hidden = 1 AND hidden_until IS NOT NULL AND hidden_until <= ?2",
            params![now, today],
        )?;
        Ok(n)
    }
}

fn list_notes_inner(conn: &Connection, hidden: HiddenFilter) -> anyhow::Result<Vec<Note>> {
    let mut sql = String::from(
        "SELECT id, body, sort_order, created_at, updated_at, hidden, hidden_until
         FROM notes WHERE body != ''");
    sql.push_str(hidden.clause());
    sql.push_str(" ORDER BY sort_order, created_at");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], note_from_row)?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

// Build a Note from a 7-column SELECT row (id..hidden_until).
fn note_from_row(r: &rusqlite::Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: r.get(0)?,
        body: r.get(1)?,
        sort_order: r.get(2)?,
        created_at: r.get(3)?,
        updated_at: r.get(4)?,
        hidden: r.get::<_, i64>(5)? != 0,
        hidden_until: r.get(6)?,
    })
}

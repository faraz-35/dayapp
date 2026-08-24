// Notes module — free-form multiline text (quotes, scratch, paste).
// Deliberately separate from items/actions: notes are *content*, not activity,
// so they have their own table and are never logged to the journal.
//
// All methods hang off the shared `Db` struct but touch only the `notes` table,
// keeping the two feature areas decoupled at the storage layer.
//
// Notes carry the same priority/project axes as items, set with the same token
// grammar — generalized to multi-line bodies: a trailing line (after a blank
// line) of only `!1..3`/`#tag` tokens, caught on blur/capture. The tokens are
// *input syntax*, never stored: the frontend parses them (lib.ts, exactly like
// items' capture) and sets the columns through the two setters below. The list
// orders by tier the way the Backlog does, straight from the columns.

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
    pub priority: Option<i64>,
    pub project_id: Option<String>,
}

impl Db {
    // ---- Notes ------------------------------------------------------------

    /// All notes ordered by priority tier first (unmarked last), then manual
    /// order — the Backlog's ordering, so the grouped Notes list and `--notes`
    /// render in tier order straight from the query. `hidden` picks the ⌘P
    /// visibility mode — Include/Only render archived notes inline in the
    /// notes list.
    pub fn list_notes(&self, hidden: HiddenFilter) -> anyhow::Result<Vec<Note>> {
        let conn = self.conn.lock().unwrap();
        list_notes_inner(&conn, hidden)
    }

    /// Create a new note with the given body at the bottom of the list. The
    /// body is stored verbatim — tokens are parsed frontend-side (like item
    /// capture) and applied afterwards through the setters below.
    pub fn create_note(&self, body: &str) -> anyhow::Result<Note> {
        let conn = self.conn.lock().unwrap();
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
            priority: None,
            project_id: None,
        })
    }

    /// Update a note's body. No journal entry — notes aren't activity.
    pub fn update_note(&self, id: &str, body: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        conn.execute(
            "UPDATE notes SET body = ?1, updated_at = ?2 WHERE id = ?3",
            params![body, now, id],
        )?;
        Ok(())
    }

    /// Set (or clear) a note's priority (1–3, or None). Housekeeping like the
    /// item counterpart — not logged to `actions`.
    pub fn set_note_priority(&self, id: &str, priority: Option<i64>) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        conn.execute(
            "UPDATE notes SET priority = ?1, updated_at = ?2 WHERE id = ?3",
            params![priority, now, id],
        )?;
        Ok(())
    }

    /// Assign (or clear) a note's project — the same projects table items and
    /// goals use. Housekeeping — not logged.
    pub fn set_note_project(&self, id: &str, project_id: Option<&str>) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        conn.execute(
            "UPDATE notes SET project_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![project_id, now, id],
        )?;
        Ok(())
    }

    pub fn delete_note(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let hidden_until = hidden_until_for(duration);
        conn.execute(
            "UPDATE notes SET hidden = 1, hidden_until = ?1, updated_at = ?2 WHERE id = ?3",
            params![hidden_until, now, id],
        )?;
        Ok(())
    }

    pub fn unhide_note(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
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
        "SELECT id, body, sort_order, created_at, updated_at, hidden, hidden_until, priority, project_id
         FROM notes WHERE body != ''");
    sql.push_str(hidden.clause());
    sql.push_str(" ORDER BY COALESCE(priority, 99), sort_order, created_at");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], note_from_row)?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

// Build a Note from a 9-column SELECT row (id..project_id).
fn note_from_row(r: &rusqlite::Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: r.get(0)?,
        body: r.get(1)?,
        sort_order: r.get(2)?,
        created_at: r.get(3)?,
        updated_at: r.get(4)?,
        hidden: r.get::<_, i64>(5)? != 0,
        hidden_until: r.get(6)?,
        priority: r.get(7)?,
        project_id: r.get(8)?,
    })
}

// ---- The stored-footer migration -------------------------------------------
//
// An earlier build of the footer feature stored the token line verbatim in the
// body and derived the columns from it on every write. The shipped model keeps
// the body pure prose (tokens are input syntax, consumed at capture/blur), so
// on open we consume any stored footers once: strip the token line from the
// body and write its values into the columns (the tag resolves — and creates —
// through the same rule an item's trailing `#tag` follows). Idempotent: with
// no footer left in a body there is nothing to consume.

/// Consume footer lines still stored in note bodies into the columns. Returns
/// the number of notes touched. Runs inside migrate() on every open.
pub(crate) fn consume_stored_note_footers(conn: &Connection) -> anyhow::Result<usize> {
    let bodies: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT id, body FROM notes")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut v = Vec::new();
        for r in rows { v.push(r?); }
        v
    };
    let now = now_iso();
    let mut n = 0;
    for (id, body) in bodies {
        let Some((stripped, priority, tag)) = split_note_footer(&body) else { continue };
        let project_id = match tag {
            Some(t) => Some(crate::projects::resolve_or_create_project(conn, &t)?),
            None => None,
        };
        conn.execute(
            "UPDATE notes SET body = ?1, priority = ?2, project_id = ?3, updated_at = ?4 WHERE id = ?5",
            params![stripped, priority, project_id, now, id],
        )?;
        n += 1;
    }
    Ok(n)
}

/// Split a stored footer into (body without it, priority, project tag), each
/// metadata field independently optional. None when the body doesn't end in a
/// valid footer: the last non-empty line must be preceded by a blank one and
/// consist only of `!1..3` and/or `#tag` tokens (any prose on it makes the
/// whole line text). Repeated tokens of a kind: last wins.
fn split_note_footer(body: &str) -> Option<(String, Option<i64>, Option<String>)> {
    let lines: Vec<&str> = body.lines().collect();
    // The footer candidate: the last non-empty line, preceded by a blank one.
    let last = lines.iter().rposition(|l| !l.trim().is_empty())?;
    if last == 0 || !lines[last - 1].trim().is_empty() {
        return None;
    }
    let mut priority: Option<i64> = None;
    let mut tag: Option<String> = None;
    for tok in lines[last].split_whitespace() {
        let b = tok.as_bytes();
        if b.len() == 2 && b[0] == b'!' && (b'1'..=b'3').contains(&b[1]) {
            priority = Some((b[1] - b'0') as i64);
        } else if b.first() == Some(&b'#') && is_tag_word(&tok[1..]) {
            tag = Some(tok[1..].to_string());
        } else {
            return None; // prose on the line → the whole line is prose
        }
    }
    Some((lines[..last - 1].join("\n").trim_end().to_string(), priority, tag))
}

/// Tag characters, mirroring the TS capture grammar's `[\w-]` (ASCII word
/// chars + hyphen — the tag must be one word).
fn is_tag_word(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::HiddenFilter;

    fn split(body: &str) -> Option<(String, Option<i64>, Option<String>)> {
        split_note_footer(body)
    }

    #[test]
    fn footer_split_parses_and_strips() {
        assert_eq!(
            split("ship essay\n\n!2 #writing"),
            Some(("ship essay".into(), Some(2), Some("writing".into()))),
        );
        assert_eq!(split("n\n\n#only"), Some(("n".into(), None, Some("only".into()))));
        assert_eq!(split("n\n\n!1"), Some(("n".into(), Some(1), None)));
        // Either order; last token of a kind wins.
        assert_eq!(
            split("n\n\n#foo !3"),
            Some(("n".into(), Some(3), Some("foo".into()))),
        );
        // Trailing blank lines after the footer are tolerated.
        assert_eq!(
            split("n\n\n!2 #foo\n\n"),
            Some(("n".into(), Some(2), Some("foo".into()))),
        );
    }

    #[test]
    fn footer_split_rejects_prose() {
        assert_eq!(split("!2 #foo"), None);        // first line of the body
        assert_eq!(split("n\n!2"), None);          // no blank line separating it
        assert_eq!(split("n\n\njust text"), None); // prose on the last line
        assert_eq!(split("n\n\n!4"), None);        // 4 isn't a tier
        assert_eq!(split("n\n\n#"), None);         // empty tag
        assert_eq!(split(""), None);
        assert_eq!(split("plain note"), None);
    }

    #[test]
    fn setters_and_tier_ordering() {
        let dir = std::env::temp_dir().join(format!("dayapp-test-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(&dir.join("t.db")).unwrap();

        let a = db.create_note("plain").unwrap();
        let b = db.create_note("top").unwrap();
        db.set_note_priority(&b.id, Some(1)).unwrap();
        db.set_note_priority(&a.id, Some(2)).unwrap();
        let list = db.list_notes(HiddenFilter::Exclude).unwrap();
        let prios: Vec<Option<i64>> = list.iter().map(|n| n.priority).collect();
        assert_eq!(prios, vec![Some(1), Some(2)]);

        // Clearing is explicit — the setter with None.
        db.set_note_priority(&a.id, None).unwrap();
        assert_eq!(db.list_notes(HiddenFilter::Exclude).unwrap()[0].priority, Some(1));

        // The stored-footer migration: a body still carrying a token line gets
        // it consumed into the columns (tag resolves/creates like items).
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE notes SET body = 'old\n\n!2 #acme', priority = NULL, project_id = NULL WHERE id = ?1",
            params![a.id],
        ).unwrap();
        drop(conn);
        let consumed = {
            let conn = db.conn.lock().unwrap();
            consume_stored_note_footers(&conn).unwrap()
        };
        assert_eq!(consumed, 1);
        let migrated = db.list_notes(HiddenFilter::Exclude).unwrap()
            .into_iter().find(|n| n.id == a.id).unwrap();
        assert_eq!(migrated.body, "old");
        assert_eq!(migrated.priority, Some(2));
        assert!(migrated.project_id.is_some());
        assert_eq!(db.list_projects().unwrap()[0].name, "acme");
    }
}

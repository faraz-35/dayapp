// Notes module — free-form multiline text (quotes, scratch, paste).
// Deliberately separate from items/actions: notes are *content*, not activity,
// so they have their own table and are never logged to the journal.
//
// All methods hang off the shared `Db` struct but touch only the `notes` table,
// keeping the two feature areas decoupled at the storage layer.
//
// Notes carry the same priority/project axes as items, generalized to
// multi-line content via the metadata footer: a body may end with a blank line
// and then a final line of only `!1..3` and/or `#tag` tokens (the note-body
// counterpart of items' end-of-line tokens). The footer is stored verbatim —
// editing the line in the textarea IS how you change the metadata; there is no
// popover. The `priority`/`project_id` columns are derived from the footer
// inside every body write (the body is the source of truth, the columns a
// cache), so they can never drift and the tier-grouped list ordering is a plain
// SQL ORDER BY — the same shape as the Backlog's.

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
    /// body is stored verbatim; priority/project are derived from its footer
    /// here (every write derives — the columns are never passed in).
    pub fn create_note(&self, body: &str) -> anyhow::Result<Note> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let id = ulid::Ulid::new().to_string();
        let max_order: i64 = conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) FROM notes",
            [], |r| r.get(0),
        )?;
        let sort_order = max_order + 1;
        let (priority, project_id) = derive_note_meta(&conn, body)?;

        conn.execute(
            "INSERT INTO notes (id, body, sort_order, created_at, updated_at, priority, project_id)
             VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6)",
            params![id, body, sort_order, now, priority, project_id],
        )?;

        Ok(Note {
            id,
            body: body.to_string(),
            sort_order,
            created_at: now.clone(),
            updated_at: now,
            hidden: false,
            hidden_until: None,
            priority,
            project_id,
        })
    }

    /// Update a note's body. No journal entry — notes aren't activity. Returns
    /// the saved row (priority/project re-derived from the body's footer in the
    /// same write) so the caller can reconcile tier grouping and the project
    /// label immediately, without waiting for the next refresh.
    pub fn update_note(&self, id: &str, body: &str) -> anyhow::Result<Note> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let (priority, project_id) = derive_note_meta(&conn, body)?;
        conn.execute(
            "UPDATE notes SET body = ?1, priority = ?3, project_id = ?4, updated_at = ?2 WHERE id = ?5",
            params![body, now, priority, project_id, id],
        )?;
        get_note_inner(&conn, id)
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

fn get_note_inner(conn: &Connection, id: &str) -> anyhow::Result<Note> {
    Ok(conn.query_row(
        "SELECT id, body, sort_order, created_at, updated_at, hidden, hidden_until, priority, project_id
         FROM notes WHERE id = ?1",
        params![id], note_from_row,
    )?)
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

// ---- The metadata footer ---------------------------------------------------
//
// A note body may end with: at least one blank line, then a final line holding
// *only* `!1..3` and/or `#tag` tokens. Strictness does the work — the blank
// line separates metadata from prose, and any prose on the last line makes it
// just text (so "wow!!" or a markdown-ish "# Heading" line never parses). The
// footer must be the last non-empty line (trailing blanks are tolerated) and
// can't be the body's first line. Repeated tokens of a kind: last wins, the
// same rule the item parsers apply. There is deliberately no `!0`/`#0` clear
// token — the footer is the full truth on every save, so removing a token (or
// the whole line) IS the clear.

/// Parse a body's footer into (priority, project tag), each independently
/// optional. None when the body doesn't end in a valid footer.
fn parse_note_footer(body: &str) -> Option<(Option<i64>, Option<String>)> {
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
    Some((priority, tag))
}

/// Tag characters, mirroring the TS capture grammar's `[\w-]` (ASCII word
/// chars + hyphen — the tag must be one word).
fn is_tag_word(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Derive a body's (priority, project_id) columns. The project tag resolves
/// with the exact semantics an item's trailing `#tag` gets in the frontend
/// (exact name, else unique prefix, else create — see
/// projects::resolve_or_create_project). A body without a footer clears both
/// columns: the footer is the whole truth.
fn derive_note_meta(conn: &Connection, body: &str) -> anyhow::Result<(Option<i64>, Option<String>)> {
    match parse_note_footer(body) {
        None => Ok((None, None)),
        Some((priority, tag)) => Ok((
            priority,
            match tag {
                Some(t) => Some(crate::projects::resolve_or_create_project(conn, &t)?),
                None => None,
            },
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::HiddenFilter;

    fn p(body: &str) -> Option<(Option<i64>, Option<String>)> {
        parse_note_footer(body)
    }

    #[test]
    fn parses_valid_footers() {
        assert_eq!(p("ship essay\n\n!2 #writing"), Some((Some(2), Some("writing".into()))));
        assert_eq!(p("n\n\n#only"), Some((None, Some("only".into()))));
        assert_eq!(p("n\n\n!1"), Some((Some(1), None)));
        // Either order; last token of a kind wins, like the item parsers.
        assert_eq!(p("n\n\n#foo !3"), Some((Some(3), Some("foo".into()))));
        assert_eq!(p("n\n\n!1 !2"), Some((Some(2), None)));
        assert_eq!(p("n\n\n#foo #bar"), Some((None, Some("bar".into()))));
        // Trailing blank lines after the footer are tolerated.
        assert_eq!(p("n\n\n!2 #foo\n\n"), Some((Some(2), Some("foo".into()))));
        // Hyphens/underscores are tag word chars, like `[\w-]`.
        assert_eq!(p("n\n\n#day-app_2"), Some((None, Some("day-app_2".into()))));
    }

    #[test]
    fn rejects_prose_and_malformed_footers() {
        assert_eq!(p("!2 #foo"), None);        // first line of the body — no blank above
        assert_eq!(p("n\n!2"), None);          // no blank line separating it
        assert_eq!(p("n\n\njust text"), None); // prose on the last line
        assert_eq!(p("n\n\n#foo bar"), None);  // two words
        assert_eq!(p("n\n\n!4"), None);        // 4 isn't a tier
        assert_eq!(p("n\n\n!0 #foo"), None);   // no clear token — remove the footer instead
        assert_eq!(p("n\n\n#"), None);         // empty tag
        assert_eq!(p("n\n\nwow!!"), None);     // '!' mid-word isn't a token
        assert_eq!(p(""), None);
        assert_eq!(p("plain note"), None);
    }

    #[test]
    fn saves_derive_and_re_derive_footer_meta() {
        let dir = std::env::temp_dir().join(format!("dayapp-test-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(&dir.join("t.db")).unwrap();

        // An unmatched footer tag creates its project (the items' trailing-tag
        // rule); the columns come back derived from the body.
        let a = db.create_note("scratch\n\n!2 #acme").unwrap();
        assert_eq!(a.priority, Some(2));
        let proj = db.list_projects().unwrap();
        assert_eq!(proj.len(), 1);
        assert_eq!(proj[0].name, "acme");
        assert_eq!(a.project_id, Some(proj[0].id.clone()));

        // A prefix match resolves like the frontend's parser; tier ordering is
        // P1 → P3 → unmarked off the same query the GUI list uses.
        let b = db.create_note("top\n\n!1 #ac").unwrap();
        assert_eq!(b.project_id, Some(proj[0].id.clone()));
        db.create_note("plain").unwrap();
        let list = db.list_notes(HiddenFilter::Exclude).unwrap();
        let prios: Vec<Option<i64>> = list.iter().map(|n| n.priority).collect();
        assert_eq!(prios, vec![Some(1), Some(2), None]);

        // Editing the footer re-derives in the same write; removing it clears
        // both columns (the footer is the whole truth — no clear token).
        let saved = db.update_note(&a.id, "scratch\n\n!1").unwrap();
        assert_eq!(saved.priority, Some(1));
        assert_eq!(saved.project_id, None);
        let cleared = db.update_note(&a.id, "just prose now").unwrap();
        assert_eq!(cleared.priority, None);
        assert_eq!(cleared.project_id, None);

        // Deleting the project nulls the link (delete_project covers notes);
        // the footer text stays in the body, so a later save re-resolves it.
        db.delete_project(&proj[0].id).unwrap();
        let relinked = db.update_note(&b.id, "top\n\n!1 #acme").unwrap();
        assert_ne!(relinked.project_id, None);
    }
}

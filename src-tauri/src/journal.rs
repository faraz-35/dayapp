// Journal module — the typed-capture store behind the notes bus.
//
// The Notes capture bar is the app's lowest-friction input; a leading `##j` /
// `##q` token turns one capture into a different *kind* of content that is
// stored and displayed differently:
//
//   ##j  a journal entry — one line of reflection, stamped with its day,
//        rendered by the Journal view (its own page; Analytics owns the
//        aggregates over `actions`, this owns the written word).
//   ##q  a quote — rendered by the rotating quote line under the header and
//        managed in the Journal view's Quotes group.
//
// Entries are content, not activity (exactly the notes/sessions call): they
// are NOT logged to `actions`. The action log stays the journal of *what was
// done*; this table is the journal of *what was thought*. A reserved `##`
// prefix was chosen over `#tag` so kinds never collide with the project axis —
// an entry has no priority, no project, no hide, no sort: just text and its
// day.
//
// All methods hang off the shared `Db` struct but touch only the `entries`
// table, keeping feature areas decoupled at the storage layer.

use crate::db::{now_iso, today_iso, Db};
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    /// `journal` (a ##j line) or `quote` (a ##q line).
    pub kind: String,
    pub text: String,
    /// ISO `YYYY-MM-DD` — the local day at capture. Journal entries group by
    /// it; it never changes on later edits (created_at keeps full order).
    pub day: String,
    pub created_at: String,
}

impl Db {
    // ---- Entries ----------------------------------------------------------

    /// All entries, newest day first; within a day oldest → newest (the
    /// reading order the Journal view renders). The ULID is the final
    /// tiebreaker — `created_at` has second granularity, and ULIDs sort
    /// chronologically as text, so a burst of captures keeps a deterministic
    /// order. The frontend splits by kind — both kinds are small and always
    /// wanted together on one fetch.
    pub fn list_entries(&self) -> anyhow::Result<Vec<Entry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, kind, text, day, created_at FROM entries
             ORDER BY day DESC, created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map([], entry_from_row)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Create an entry of the given kind, stamped with the local today. The
    /// kind comes from the frontend's token parse — invalid kinds are
    /// rejected here (the CHECK constraint would do it, but a clean error is
    /// kinder than a constraint violation).
    pub fn add_entry(&self, kind: &str, text: &str) -> anyhow::Result<Entry> {
        if !matches!(kind, "journal" | "quote") {
            anyhow::bail!("unknown entry kind: {kind}");
        }
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let id = ulid::Ulid::new().to_string();
        let day = today_iso();
        conn.execute(
            "INSERT INTO entries (id, kind, text, day, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, kind, text, day, now],
        )?;
        Ok(Entry {
            id,
            kind: kind.to_string(),
            text: text.to_string(),
            day,
            created_at: now,
        })
    }

    /// Edit an entry's text. The day is untouched — editing yesterday's
    /// reflection tomorrow doesn't move it to tomorrow. No journal logging
    /// (content, like note edits).
    pub fn update_entry(&self, id: &str, text: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE entries SET text = ?1 WHERE id = ?2", params![text, id])?;
        Ok(())
    }

    pub fn delete_entry(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM entries WHERE id = ?1", params![id])?;
        Ok(())
    }
}

fn entry_from_row(r: &rusqlite::Row) -> rusqlite::Result<Entry> {
    Ok(Entry {
        id: r.get(0)?,
        kind: r.get(1)?,
        text: r.get(2)?,
        day: r.get(3)?,
        created_at: r.get(4)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_roundtrip_and_day_ordering() {
        let dir = std::env::temp_dir().join(format!("dayapp-test-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(&dir.join("t.db")).unwrap();

        let today = today_iso();
        let j1 = db.add_entry("journal", "shipped the notes bus").unwrap();
        let q1 = db.add_entry("quote", "The log is the journal.").unwrap();
        assert_eq!(j1.day, today);
        assert_eq!(q1.kind, "quote");

        db.update_entry(&j1.id, "shipped the notes bus, cleanly").unwrap();
        let all = db.list_entries().unwrap();
        assert_eq!(all.len(), 2);
        let j = all.iter().find(|e| e.id == j1.id).unwrap();
        assert_eq!(j.text, "shipped the notes bus, cleanly");
        assert_eq!(j.day, today, "edits never move the day");

        // The next day (simulated directly — day comes from today_iso at
        // capture, so write a backdated row) sorts above it.
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO entries (id, kind, text, day, created_at) VALUES ('e-yd','journal','older','2000-01-01','2000-01-01T09:00:00')",
                [],
            )
            .unwrap();
        }
        let all = db.list_entries().unwrap();
        assert_eq!(all[0].id, j1.id, "newer day first");
        assert_eq!(all[all.len() - 1].id, "e-yd");

        db.delete_entry(&q1.id).unwrap();
        assert_eq!(db.list_entries().unwrap().len(), 2);

        assert!(db.add_entry("diary", "x").is_err(), "unknown kinds rejected");
    }
}

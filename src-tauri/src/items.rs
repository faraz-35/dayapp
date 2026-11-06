// Items — the task rows' CRUD. Every write to `items` is wrapped in a
// transaction that also appends to `actions` (log_action in actions.rs): the
// log must never drift from the live row. Cross-surface invariants (stopping
// a running timer on complete/delete, clearing remind_at on any Backlog
// exit) are enforced INSIDE these methods, never at call sites — the GUI's
// state is stale against CLI writes. See AGENTS.md "Data model".

use rusqlite::params;
use crate::actions::log_action;
use crate::db::{hidden_until_for, now_iso, today_iso, Db, HiddenFilter, Item};
use crate::timers::finalize_open_session_for_item;

impl Db {
    pub fn list(&self, section: &str, include_done: bool, hidden: HiddenFilter) -> anyhow::Result<Vec<Item>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = String::from(
            "SELECT id,text,section,status,last_completed_date,sort_order,created_at,updated_at,hidden,hidden_until,project_id,remind_at,priority,assigned_to_agent,details
             FROM items WHERE section = ?1");
        if !include_done && hidden != HiddenFilter::Only {
            sql.push_str(" AND status = 'active'");
        }
        sql.push_str(hidden.clause());
        sql.push_str(if section == "backlog" {
            " ORDER BY COALESCE(priority, 99), sort_order, created_at"
        } else {
            " ORDER BY sort_order, created_at"
        });
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![section], item_from_row)?;
        let mut out = Vec::new();
        for row in rows { out.push(row?); }
        Ok(out)
    }

    // ---- Writes ----------------------------------------------------------
    //
    // Every write mutates `items` AND appends to `actions`. The log is the journal;
    // it must never drift from the live row. These are wrapped in a transaction.

    /// `project_id`/`priority` ride the INSERT and are ON the row before
    /// `log_action` fires — the `created` action snapshots the live row, and
    /// that birth snapshot is the analytics Created lens's whole data. (The
    /// pre-2026-09-14 two-step capture — create bare, set tokens after —
    /// left every created action NULL-attributed; `migrate` backfills those
    /// once.)
    pub fn create_item(
        &self, text: &str, section: &str,
        project_id: Option<&str>, priority: Option<i64>,
    ) -> anyhow::Result<Item> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let id = ulid::Ulid::new().to_string();
        let max_order: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) FROM items WHERE section = ?1",
                params![section], |r| r.get(0),
            )?;
        let sort_order = max_order + 1;

        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO items (id,text,section,status,last_completed_date,sort_order,created_at,updated_at,project_id,priority)
             VALUES (?1,?2,?3,'active',NULL,?4,?5,?5,?6,?7)",
            params![id, text, section, sort_order, now, project_id, priority],
        )?;
        log_action(&tx, &id, text, "created", None, Some(section), None, Some("active"), &now)?;
        tx.commit()?;

        Ok(Item {
            id, text: text.to_string(), section: section.to_string(),
            status: "active".into(), last_completed_date: None,
            sort_order, created_at: now.clone(), updated_at: now,
            hidden: false, hidden_until: None,
            project_id: project_id.map(String::from), remind_at: None, priority,
            assigned_to_agent: false, details: String::new(),
        })
    }

    pub fn edit_item(&self, id: &str, text: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let tx = conn.unchecked_transaction()?;
        let (old_text, section): (String, String) = tx.query_row(
            "SELECT text, section FROM items WHERE id = ?1", params![id],
            |r| Ok((r.get(0)?, r.get(1)?)))?;
        tx.execute(
            "UPDATE items SET text = ?1, updated_at = ?2 WHERE id = ?3",
            params![text, now, id])?;
        // Only log if it actually changed; keeps the journal clean.
        if old_text != text {
            log_action(&tx, id, text, "edited", Some(&section), Some(&section), None, None, &now)?;
        }
        Ok(tx.commit()?)
    }

    /// Mark a non-daily item done. For a daily item, records completion for
    /// today; the item stays visible but greyed. A today item also stays —
    /// crossed out like a done daily — until the day-boundary sweep retires it;
    /// `last_completed_date` is what tells that sweep which completions belong
    /// to the current day (and keeps a same-day completion safe if the sweep
    /// has already run).
    ///
    /// If this item's timer is running, the open session is finalized inside
    /// the same transaction (kept in history). The rule lives here, not in the
    /// calling surface — the GUI's view of the active timer can be stale.
    pub fn complete_item(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let today = today_iso();
        let tx = conn.unchecked_transaction()?;

        let (text, section, status): (String, String, String) = tx.query_row(
            "SELECT text, section, status FROM items WHERE id = ?1", params![id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?;

        // Completing a running item stops its timer first — same transaction,
        // whichever surface asked for the completion.
        finalize_open_session_for_item(&tx, &now, id)?;

        if section == "daily" {
            // Daily: don't flip status — record completion for today. Item stays
            // visible-but-greyed until tomorrow (driven by last_completed_date == today).
            tx.execute(
                "UPDATE items SET last_completed_date = ?1, updated_at = ?2 WHERE id = ?3",
                params![today, now, id])?;
            log_action(&tx, id, &text, "completed", Some(&section), Some(&section),
                       Some(&status), Some(&status), &now)?;
        } else {
            tx.execute(
                "UPDATE items SET status = 'done', last_completed_date = ?1, updated_at = ?2 WHERE id = ?3",
                params![today, now, id])?;
            log_action(&tx, id, &text, "completed", Some(&section), Some(&section),
                       Some(&status), Some("done"), &now)?;
        }
        Ok(tx.commit()?)
    }

    /// Restore a completed today item to active — Enter or a checkbox click on
    /// a crossed row toggles it back. Logs `uncompleted`, the inverse of the
    /// completion entry, so the journal shows the correction.
    pub fn uncomplete_item(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let tx = conn.unchecked_transaction()?;
        let (text, section, status): (String, String, String) = tx.query_row(
            "SELECT text, section, status FROM items WHERE id = ?1", params![id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?;
        tx.execute(
            "UPDATE items SET status = 'active', last_completed_date = NULL, updated_at = ?1 WHERE id = ?2",
            params![now, id])?;
        log_action(&tx, id, &text, "uncompleted", Some(&section), Some(&section),
                   Some(&status), Some("active"), &now)?;
        Ok(tx.commit()?)
    }

    /// Move an item to a different section (drag, or programmatic).
    /// Re-indexes sort_order in the destination so it stays contiguous.
    pub fn move_item(&self, id: &str, to_section: &str, new_index: i64) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let tx = conn.unchecked_transaction()?;

        let (text, from_section): (String, String) = tx.query_row(
            "SELECT text, section FROM items WHERE id = ?1", params![id],
            |r| Ok((r.get(0)?, r.get(1)?)))?;

        if from_section != to_section {
            // Leaving the Backlog retires any pending reminder: a reminder's
            // whole job is "pull this row into Today on its date", and the row
            // has now been pulled — by drag, the Backlog's send-to-Today
            // button, or --move. The same clearing the sweep's promotion does,
            // enforced in the transaction so every surface gets it and a
            // reminder can never sit stale on a non-Backlog row
            // (promote_due_reminders only scans the Backlog).
            if from_section == "backlog" {
                tx.execute(
                    "UPDATE items SET section = ?1, remind_at = NULL, updated_at = ?2 WHERE id = ?3",
                    params![to_section, now, id])?;
            } else {
                tx.execute(
                    "UPDATE items SET section = ?1, updated_at = ?2 WHERE id = ?3",
                    params![to_section, now, id])?;
            }
            log_action(&tx, id, &text, "moved",
                       Some(&from_section), Some(to_section), None, None, &now)?;
        }

        // Re-index destination section so sort_order is contiguous & matches new_index.
        // Simple approach: load all ids in dest in desired order, write 0..N.
        // The Backlog is priority-sorted for display, so index in that same
        // order there — drops land where they visually fell (priority stays
        // the primary axis; manual order applies within a tier).
        let dest_order = if to_section == "backlog" {
            "ORDER BY COALESCE(priority, 99), sort_order, created_at"
        } else {
            "ORDER BY sort_order, created_at"
        };
        let mut ids: Vec<String> = {
            let mut stmt = tx.prepare(&format!(
                "SELECT id FROM items WHERE section = ?1 AND id != ?2 {dest_order}"
            ))?;
            let rows = stmt.query_map(params![to_section, id], |r| r.get::<_,String>(0))?;
            let mut v = Vec::new();
            for r in rows { v.push(r?); }
            v
        };
        let insert_at = (new_index as usize).min(ids.len());
        ids.insert(insert_at, id.to_string());
        for (i, row_id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE items SET sort_order = ?1 WHERE id = ?2",
                params![i as i64, row_id])?;
        }
        Ok(tx.commit()?)
    }

    /// Delete an item. Any open session on it is finalized first, in the same
    /// transaction (the session is kept — its item_text snapshot survives the
    /// deletion, like actions), so a running timer can never outlive its row.
    pub fn delete_item(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let tx = conn.unchecked_transaction()?;
        let (text, section): (String, String) = tx.query_row(
            "SELECT text, section FROM items WHERE id = ?1", params![id],
            |r| Ok((r.get(0)?, r.get(1)?)))?;
        finalize_open_session_for_item(&tx, &now, id)?;
        // Log while the row still exists — the action's project/priority
        // snapshot subqueries read the live item (see log_action).
        log_action(&tx, id, &text, "deleted", Some(&section), None, None, None, &now)?;
        tx.execute("DELETE FROM items WHERE id = ?1", params![id])?;
        Ok(tx.commit()?)
    }

    // ---- Pause (hide) -----------------------------------------------------
    //
    // Soft-archive: the row stays in `items` so it can be unhidden, but
    // `list()` filters hidden=0. `hidden_until` is NULL for "forever", else an
    // ISO date at which `unhide_expired_items` (run by the launch sweep) clears
    // it. The hidden flag is the display mechanism; `paused`/`unpaused`
    // actions are its dated record — the daily-miss replay folds them to know
    // which days a habit was paused, so this IS logged to `actions` (unlike
    // the other housekeeping writes).

    /// Hide (pause) an item. `duration` is one of: forever | day | week | month.
    pub fn hide_item(&self, id: &str, duration: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let hidden_until = hidden_until_for(duration);
        let tx = conn.unchecked_transaction()?;
        let (text, section): (String, String) = tx.query_row(
            "SELECT text, section FROM items WHERE id = ?1", params![id],
            |r| Ok((r.get(0)?, r.get(1)?)))?;
        tx.execute(
            "UPDATE items SET hidden = 1, hidden_until = ?1, updated_at = ?2 WHERE id = ?3",
            params![hidden_until, now, id],
        )?;
        log_action(&tx, id, &text, "paused", Some(&section), Some(&section), None, None, &now)?;
        Ok(tx.commit()?)
    }

    /// Unhide (unpause) an item — clears both the flag and the expiry.
    pub fn unhide_item(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let tx = conn.unchecked_transaction()?;
        let (text, section): (String, String) = tx.query_row(
            "SELECT text, section FROM items WHERE id = ?1", params![id],
            |r| Ok((r.get(0)?, r.get(1)?)))?;
        tx.execute(
            "UPDATE items SET hidden = 0, hidden_until = NULL, updated_at = ?1 WHERE id = ?2",
            params![now, id],
        )?;
        log_action(&tx, id, &text, "unpaused", Some(&section), Some(&section), None, None, &now)?;
        Ok(tx.commit()?)
    }

    /// Clear the hidden flag on any item whose time-limited hide has expired.
    /// Called by the launch + 60s-tick sweep, so hides auto-restore at the day
    /// boundary without a cron job. Each restore logs `unpaused` — the pause
    /// window's close. Idempotent. Returns the number of rows restored.
    pub fn unhide_expired_items(&self) -> anyhow::Result<usize> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let today = today_iso();
        let tx = conn.unchecked_transaction()?;
        let expiring: Vec<(String, String, String)> = {
            let mut stmt = tx.prepare(
                "SELECT id, text, section FROM items
                 WHERE hidden = 1 AND hidden_until IS NOT NULL AND hidden_until <= ?1")?;
            let rows = stmt.query_map(params![today], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
            })?;
            rows.filter_map(|r| r.ok()).collect()
        };
        for (id, text, section) in &expiring {
            tx.execute(
                "UPDATE items SET hidden = 0, hidden_until = NULL, updated_at = ?1 WHERE id = ?2",
                params![now, id],
            )?;
            log_action(&tx, id, text, "unpaused", Some(section), Some(section), None, None, &now)?;
        }
        tx.commit()?;
        Ok(expiring.len())
    }

    /// Set (or clear) an item's reminder. `remind_at` is an ISO YYYY-MM-DD on
    /// which a backlog item auto-promotes to Today, or None to clear.
    /// Housekeeping — not logged to actions.
    pub fn set_reminder(&self, id: &str, remind_at: Option<&str>) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        conn.execute(
            "UPDATE items SET remind_at = ?1, updated_at = ?2 WHERE id = ?3",
            params![remind_at, now, id],
        )?;
        Ok(())
    }

    /// Set (or clear) an item's priority (1–3, or None). Housekeeping like the
    /// project assignment — not logged to `actions`.
    pub fn set_item_priority(&self, id: &str, priority: Option<i64>) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        conn.execute(
            "UPDATE items SET priority = ?1, updated_at = ?2 WHERE id = ?3",
            params![priority, now, id],
        )?;
        Ok(())
    }

    /// Assign an item to (or take it back from) the AI agent — the delegation
    /// axis, set via the `@` token. Housekeeping like priority — not logged.
    pub fn set_item_agent(&self, id: &str, assigned: bool) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        conn.execute(
            "UPDATE items SET assigned_to_agent = ?1, updated_at = ?2 WHERE id = ?3",
            params![assigned, now, id],
        )?;
        Ok(())
    }

    /// Set the item's details body — the spec under the one-line title; for
    /// agent-delegated rows, the prompt an autonomous session executes.
    /// Content like notes (not item-state): housekeeping, never logged.
    pub fn set_item_details(&self, id: &str, details: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        conn.execute(
            "UPDATE items SET details = ?1, updated_at = ?2 WHERE id = ?3",
            params![details, now, id],
        )?;
        Ok(())
    }

}

fn item_from_row(r: &rusqlite::Row) -> rusqlite::Result<Item> {
    Ok(Item {
        id: r.get(0)?,
        text: r.get(1)?,
        section: r.get(2)?,
        status: r.get(3)?,
        last_completed_date: r.get(4)?,
        sort_order: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
        hidden: r.get::<_, i64>(8)? != 0,
        hidden_until: r.get(9)?,
        project_id: r.get(10)?,
        remind_at: r.get(11)?,
        priority: r.get(12)?,
        assigned_to_agent: r.get::<_, i64>(13)? != 0,
        details: r.get(14)?,
    })
}

// Fill NULL project/priority on action rows from the subjects' current state.
// Two callers: the one-time migration when the snapshot columns land on an
// existing db, and the demo seed — seeded actions are inserted with the
// columns NULL, so this stands in for the write-time snapshots a live write
// would have taken. Only touches NULL cells, so it's idempotent.

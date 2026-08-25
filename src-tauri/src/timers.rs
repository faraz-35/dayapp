// Timers module — per-task time tracking via "sessions". A session is an
// interval of focused work on one item: ▶ opens a row (ended_at NULL), ⏸ fills
// ended_at + duration_secs. Exactly one session may be open at a time (the
// single active timer); `start_timer` enforces this by finalizing any open
// session first.
//
// Timer sessions are *measurement* (content), not item-state transitions, so —
// like notes and projects — they are NOT logged to `actions`. The journal
// surfaces time as a separate dimension via `session_time_by_day`. item_text is
// snapshotted at write time so history survives edits/deletes, mirroring
// actions.item_text. Sessions deliberately carry no project/priority snapshots:
// the analytics scope filter covers actions only, not tracked time.
//
// All methods hang off the shared `Db` struct and touch only the `sessions`
// table (plus a LEFT JOIN to items for the live text of the active timer).

use crate::db::{now_iso, Db};
use chrono::{NaiveDate, NaiveDateTime};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTimer {
    pub item_id: String,
    pub item_text: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayTaskTime {
    pub day: String, // YYYY-MM-DD
    pub item_id: String,
    pub item_text: String,
    pub seconds: i64,
}

impl Db {
    // ---- Timer state ------------------------------------------------------

    /// Start timing `item_id`. Single active timer: finalizes any open session
    /// first, then opens a new one. Returns the new active timer.
    pub fn start_timer(&self, item_id: &str) -> anyhow::Result<ActiveTimer> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let tx = conn.unchecked_transaction()?;
        finalize_open_session(&tx, &now)?;
        // Snapshot the current text so history survives edits/deletes.
        let item_text: String = tx
            .query_row("SELECT text FROM items WHERE id = ?1", params![item_id], |r| r.get(0))
            .unwrap_or_default();
        let id = ulid::Ulid::new().to_string();
        tx.execute(
            "INSERT INTO sessions (id, item_id, item_text, started_at, ended_at, duration_secs)
             VALUES (?1, ?2, ?3, ?4, NULL, NULL)",
            params![id, item_id, item_text, now],
        )?;
        tx.commit()?;
        Ok(ActiveTimer {
            item_id: item_id.to_string(),
            item_text,
            started_at: now,
        })
    }

    /// Stop the active timer, finalizing its session (kept in history).
    /// Idempotent — a no-op when nothing's running.
    pub fn stop_timer(&self) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let tx = conn.unchecked_transaction()?;
        finalize_open_session(&tx, &now)?;
        tx.commit()?;
        Ok(())
    }

    /// Discard the open session entirely (delete the row instead of finalizing).
    /// For the "left it running overnight" case where the elapsed is obviously
    /// wrong. Idempotent — a no-op when nothing's running.
    pub fn discard_timer(&self) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM sessions WHERE ended_at IS NULL", [])?;
        Ok(())
    }

    /// The currently-timing item, if any. Resolves live text via a LEFT JOIN so
    /// edits are reflected; falls back to the snapshot if the item was deleted.
    pub fn get_active_timer(&self) -> anyhow::Result<Option<ActiveTimer>> {
        let conn = self.conn.lock().unwrap();
        let row = conn
            .query_row(
                "SELECT s.item_id, COALESCE(i.text, s.item_text), s.started_at
                 FROM sessions s LEFT JOIN items i ON i.id = s.item_id
                 WHERE s.ended_at IS NULL LIMIT 1",
                [],
                |r| {
                    Ok(ActiveTimer {
                        item_id: r.get(0)?,
                        item_text: r.get(1)?,
                        started_at: r.get(2)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    /// Total seconds per item for a set of ids (the visible rows). Includes
    /// completed sessions plus the live elapsed of the open session, so the
    /// running row's total keeps ticking while you watch.
    pub fn time_totals(&self, item_ids: &[String]) -> anyhow::Result<HashMap<String, i64>> {
        let conn = self.conn.lock().unwrap();
        let mut out: HashMap<String, i64> = HashMap::new();
        if !item_ids.is_empty() {
            let placeholders = item_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!(
                "SELECT item_id, COALESCE(SUM(duration_secs), 0)
                 FROM sessions
                 WHERE duration_secs IS NOT NULL AND item_id IN ({placeholders})
                 GROUP BY item_id"
            );
            // Mirror the Box<dyn ToSql> pattern used in db.rs::list_actions.
            let mut pv: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
            for id in item_ids {
                pv.push(Box::new(id.clone()));
            }
            let refs: Vec<&dyn rusqlite::ToSql> = pv.iter().map(|p| p.as_ref()).collect();
            let mut stmt = conn.prepare(&sql)?;
            let rows =
                stmt.query_map(refs.as_slice(), |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
            for r in rows {
                let (id, secs) = r?;
                out.insert(id, secs);
            }
        }
        // Add the live elapsed of the open session if its item is visible.
        if let Some((active_id, started)) = open_session_target(&conn)? {
            if item_ids.iter().any(|id| id == &active_id) {
                if let (Some(start), Some(now)) = (parse_ts(&started), parse_ts(&now_iso())) {
                    let elapsed = (now - start).num_seconds().max(0);
                    *out.entry(active_id).or_insert(0) += elapsed;
                }
            }
        }
        Ok(out)
    }

    /// Per-day, per-task seconds for the journal, for sessions overlapping the
    /// half-open [since, until) window (date-prefix bounds, like list_actions).
    /// Sessions crossing midnight are split across their calendar days so daily
    /// totals stay accurate. Includes the open session's elapsed-to-now.
    /// Deliberately NOT scope-filtered (see the module comment): time is a
    /// separate dimension the axis filters don't cover.
    pub fn session_time_by_day(
        &self,
        since: Option<&str>,
        until: Option<&str>,
    ) -> anyhow::Result<Vec<DayTaskTime>> {
        let conn = self.conn.lock().unwrap();
        let now = parse_ts(&now_iso());

        // Only the upper bound is applied in SQL (start before the window end).
        // The lower bound is applied per-day in Rust after splitting, since a
        // session may have started before `since` but end inside the window.
        let mut sql = String::from(
            "SELECT item_id, item_text, started_at, ended_at FROM sessions WHERE 1=1",
        );
        let mut pv: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(u) = until {
            sql.push_str(" AND started_at < ?");
            pv.push(Box::new(u.to_string()));
        }
        sql.push_str(" ORDER BY started_at");
        let refs: Vec<&dyn rusqlite::ToSql> = pv.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(refs.as_slice(), |r| {
            Ok((
                r.get::<_, String>(0)?, // item_id
                r.get::<_, String>(1)?, // item_text
                r.get::<_, String>(2)?, // started_at
                r.get::<_, Option<String>>(3)?, // ended_at
            ))
        })?;

        let mut acc: HashMap<(String, String), (String, i64)> = HashMap::new();
        for row in rows {
            let (item_id, item_text, started, ended) = row?;
            let Some(start) = parse_ts(&started) else { continue };
            let Some(now) = now else { continue };
            // An open session runs to "now"; a closed one to its ended_at.
            let end = ended.as_deref().and_then(parse_ts).unwrap_or(now);
            for (day, secs) in session_day_splits(start, end) {
                let day_str = day.format("%Y-%m-%d").to_string();
                if let Some(s) = since {
                    if day_str.as_str() < s {
                        continue;
                    }
                }
                if let Some(u) = until {
                    if day_str.as_str() >= u {
                        continue;
                    }
                }
                let entry = acc
                    .entry((day_str, item_id.clone()))
                    .or_insert((item_text.clone(), 0));
                entry.1 += secs;
            }
        }

        let mut out: Vec<DayTaskTime> = acc
            .into_iter()
            .map(|((day, item_id), (item_text, seconds))| DayTaskTime {
                day,
                item_id,
                item_text,
                seconds,
            })
            .collect();
        // Deterministic order: day desc, then seconds desc — matches the journal.
        out.sort_by(|a, b| b.day.cmp(&a.day).then_with(|| b.seconds.cmp(&a.seconds)));
        Ok(out)
    }
}

// Finalize the open session (if any) with ended_at = now and a computed
// duration. The single-active-timer invariant guarantees at most one row has
// ended_at IS NULL, so this is unambiguous.
fn finalize_open_session(tx: &rusqlite::Transaction, now: &str) -> anyhow::Result<()> {
    let started: Option<String> = tx
        .query_row(
            "SELECT started_at FROM sessions WHERE ended_at IS NULL LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(s) = started {
        tx.execute(
            "UPDATE sessions SET ended_at = ?1, duration_secs = ?2 WHERE ended_at IS NULL",
            params![now, secs_between(&s, now)],
        )?;
    }
    Ok(())
}

/// Finalize the open session if it belongs to `item_id` — the backend half of
/// "completing/deleting a running item stops its timer first". Called inside
/// db.rs's completion/deletion transactions so the rule holds no matter which
/// surface triggered the write: the GUI's notion of the active timer can be
/// stale (a session started from the CLI is invisible to it until re-pulled),
/// but the db can't be. The session itself is kept — only the clock stops.
pub(crate) fn finalize_open_session_for_item(
    tx: &rusqlite::Transaction,
    now: &str,
    item_id: &str,
) -> anyhow::Result<()> {
    let started: Option<String> = tx
        .query_row(
            "SELECT started_at FROM sessions WHERE ended_at IS NULL AND item_id = ?1 LIMIT 1",
            params![item_id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(s) = started {
        tx.execute(
            "UPDATE sessions SET ended_at = ?1, duration_secs = ?2
             WHERE ended_at IS NULL AND item_id = ?3",
            params![now, secs_between(&s, now), item_id],
        )?;
    }
    Ok(())
}

/// Finalize open sessions on completed-today rows the sweep is about to
/// retire. With complete_item stopping timers itself this is pure self-heal
/// for orphaned sessions written before that rule existed — without it they'd
/// keep ticking forever, outliving their deleted item with no row to stop
/// them from. `today` is the retirement cutoff, same predicate as the DELETE.
pub(crate) fn finalize_retiring_today_sessions(
    tx: &rusqlite::Transaction,
    now: &str,
    today: &str,
) -> anyhow::Result<()> {
    tx.execute(
        "UPDATE sessions SET ended_at = ?1,
            duration_secs = MAX(0, CAST(strftime('%s', ?1) AS INTEGER)
                                     - CAST(strftime('%s', started_at) AS INTEGER))
         WHERE ended_at IS NULL AND item_id IN (
            SELECT id FROM items
             WHERE section = 'today' AND status = 'done'
               AND (last_completed_date IS NULL OR last_completed_date != ?2))",
        params![now, today],
    )?;
    Ok(())
}

// Whole seconds between two now_iso() timestamps, floored at 0.
fn secs_between(started: &str, now: &str) -> Option<i64> {
    match (parse_ts(started), parse_ts(now)) {
        (Some(a), Some(b)) => Some((b - a).num_seconds().max(0)),
        _ => None,
    }
}

// The (item_id, started_at) of the open session, if any — for the live-elapsed
// component of time_totals.
fn open_session_target(conn: &rusqlite::Connection) -> anyhow::Result<Option<(String, String)>> {
    let row = conn
        .query_row(
            "SELECT item_id, started_at FROM sessions WHERE ended_at IS NULL LIMIT 1",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?;
    Ok(row)
}

// Parse a now_iso() timestamp into a local NaiveDateTime. now_iso emits RFC3339
// with a numeric offset (e.g. 2026-08-11T14:30:00+00:00); we take the first 19
// chars (the local wall-clock prefix) so day-splitting keys off local calendar
// days, consistent with how the rest of DayApp keys off local dates (see
// lib.ts localDateStr). DST edges are ignored, matching that same model.
fn parse_ts(s: &str) -> Option<NaiveDateTime> {
    let prefix = s.get(..19)?;
    NaiveDateTime::parse_from_str(prefix, "%Y-%m-%dT%H:%M:%S").ok()
}

// Split an interval [start, end) into per-calendar-day (NaiveDate, seconds)
// contributions. Sessions usually land in one day; this handles the
// across-midnight case so daily totals are accurate. Uses naive (wall-clock)
// dates — no DST modeling, matching the rest of the app's date model.
fn session_day_splits(start: NaiveDateTime, end: NaiveDateTime) -> Vec<(NaiveDate, i64)> {
    let mut out = Vec::new();
    if end <= start {
        return out;
    }
    let mut cursor = start;
    while cursor < end {
        let day = cursor.date();
        let Some(next_day) = day.succ_opt() else { break };
        let Some(next_midnight) = next_day.and_hms_opt(0, 0, 0) else { break };
        let seg_end = if end < next_midnight { end } else { next_midnight };
        let secs = (seg_end - cursor).num_seconds().max(0);
        if secs > 0 {
            out.push((day, secs));
        }
        if seg_end >= end {
            break;
        }
        cursor = next_midnight;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn tmp_db() -> (Db, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("dayapp-test-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(&dir.join("t.db")).unwrap();
        (db, dir)
    }

    fn open_session_count(db: &Db) -> i64 {
        let conn = db.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM sessions WHERE ended_at IS NULL", [], |r| r.get(0))
            .unwrap()
    }

    /// The stop-on-complete rule is enforced by complete_item itself, in its
    /// own transaction — no matter which surface asked for the completion
    /// (the GUI's view of the active timer can be stale). Completing must
    /// finalize the item's open session but leave a *different* item's timer
    /// running; the session row is kept with a duration.
    #[test]
    fn completing_an_item_stops_its_own_timer_only() {
        let (db, dir) = tmp_db();
        let a = db.create_item("timed task", "today").unwrap();
        let b = db.create_item("other task", "today").unwrap();

        // b is the running one; complete a — b's timer must be untouched.
        db.start_timer(&a.id).unwrap();
        db.start_timer(&b.id).unwrap(); // single-timer rule: a's closed, b's open
        db.complete_item(&a.id).unwrap();
        assert_eq!(open_session_count(&db), 1, "b's timer must keep running");

        // Now a is the running one; complete b — a's timer must be untouched.
        db.start_timer(&a.id).unwrap();
        db.complete_item(&b.id).unwrap();
        assert_eq!(open_session_count(&db), 1, "a's timer must keep running");

        // Complete the running item itself: its session must finalize.
        db.start_timer(&b.id).unwrap();
        db.complete_item(&b.id).unwrap();
        assert_eq!(open_session_count(&db), 0, "completing the timing item must stop it");
        // The stopped session is kept, finalized — not deleted. (duration_secs
        // is second-granular, so a fast test yields 0; NULL is the open-row mark.)
        let conn = db.conn.lock().unwrap();
        let kept: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sessions
                  WHERE item_id = ?1 AND ended_at IS NOT NULL AND duration_secs IS NOT NULL",
                params![b.id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(kept >= 2, "finalized sessions must be kept, not deleted");
        drop(conn);

        // Deleting a running item stops its timer too — same in-transaction rule.
        let c = db.create_item("doomed task", "today").unwrap();
        db.start_timer(&c.id).unwrap();
        db.delete_item(&c.id).unwrap();
        assert_eq!(open_session_count(&db), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The retirement sweep finalizes orphaned open sessions on done-today
    /// rows before deleting them (self-heal for rows written before the
    /// stop-on-complete rule existed) — a session must never outlive its item.
    #[test]
    fn retiring_sweep_finalizes_orphaned_sessions() {
        let (db, dir) = tmp_db();
        let a = db.create_item("orphaned timer", "today").unwrap();
        db.start_timer(&a.id).unwrap();
        // Simulate the pre-rule bug: complete the row via raw SQL so no path
        // stops the timer — status done, dated yesterday, session still open.
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE items SET status = 'done', last_completed_date = '2000-01-01' WHERE id = ?1",
                params![a.id],
            )
            .unwrap();
        }
        assert_eq!(open_session_count(&db), 1);

        db.purge_completed_today().unwrap();
        assert_eq!(open_session_count(&db), 0, "the retiring pass must stop the orphan");
        let conn = db.conn.lock().unwrap();
        let kept: i64 = conn
            .query_row("SELECT COUNT(*) FROM sessions WHERE item_id = ?1", params![a.id], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, 1, "the orphan's session is finalized, not deleted");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

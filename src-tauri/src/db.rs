// Database layer: connection, schema init, typed Item/Action model.
// One SQLite file at ~/Library/Application Support/DayApp/dayapp.db.
//
// rusqlite is synchronous, so callers wrap DB work in
// `tauri::async_runtime::spawn_blocking` to keep the UI thread free.

use std::sync::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};


#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub text: String,
    pub section: String,          // 'today' | 'daily' | 'backlog'
    pub status: String,           // 'active' | 'done'
    pub last_completed_date: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
    pub hidden: bool,             // soft-archive; hidden=1 keeps row out of active lists
    pub hidden_until: Option<String>,  // ISO YYYY-MM-DD when a time-limited hide expires; NULL = forever
    pub project_id: Option<String>,    // assigned project (housekeeping — not logged to actions)
    pub remind_at: Option<String>,     // ISO YYYY-MM-DD when a backlog item auto-promotes to today
    pub priority: Option<i64>,         // urgency tier 1–3 (housekeeping — not logged); Backlog sorts by it
    pub assigned_to_agent: bool,      // delegation: 1 = fully delegable to an AI agent (housekeeping — not logged)
    pub details: String,              // free-form spec under the title; for agent rows, the prompt (content — not logged)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub id: i64,
    /// Set for item rows, null for goal rows (and vice versa for goal_id).
    pub item_id: Option<String>,
    pub goal_id: Option<String>,
    pub item_text: String,
    pub action: String,
    pub from_section: Option<String>,
    pub to_section: Option<String>,
    pub from_status: Option<String>,
    pub to_status: Option<String>,
    pub timestamp: String,
}

/// How `list` treats hidden rows — the three ⌘P visibility modes over the main
/// list: the default excludes them, "Show All" includes them inline, and
/// "Show Hidden Only" returns just them (the archive view).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HiddenFilter {
    Exclude,
    Include,
    Only,
}

impl HiddenFilter {
    /// SQL fragment appending the hidden-row predicate (empty for Include,
    /// since those rows need no filter). Shared by the items and notes lists.
    pub fn clause(self) -> &'static str {
        match self {
            HiddenFilter::Exclude => " AND hidden = 0",
            HiddenFilter::Include => "",
            HiddenFilter::Only => " AND hidden = 1",
        }
    }
}

// Single shared connection behind a mutex. DayApp is single-user, single-process,
// low concurrency — a Mutex<Connection> is fine and avoids a pool dependency.
//
// `conn` is the connection every command uses. Demo mode (see demo.rs) swaps
// the Connection inside that same mutex — real ↔ demo — so no command can
// observe a half-swapped state and none of them needs to know demo exists.
// The parked side stays open in `demo` for an instant swap back.
#[derive(Debug)]
pub struct Db {
    /// The ACTIVE connection — the real db's, or the demo db's while demo
    /// mode is on.
    pub conn: Mutex<Connection>,
    /// Demo-mode state behind its own lock (commands never touch it): the
    /// mode flag plus the inactive connection, parked while swapped.
    pub demo: Mutex<DemoSlot>,
    /// The real db's path — the demo file (dayapp-demo.db) is its sibling.
    pub real_path: std::path::PathBuf,
}

#[derive(Debug, Default)]
pub struct DemoSlot {
    /// Whether `Db::conn` currently holds the demo db.
    pub active: bool,
    /// The inactive connection (the real one while demo is on, the demo one
    /// while it's off). None when the other db was never opened.
    pub parked: Option<Connection>,
}

impl Db {
    pub fn open(path: &std::path::Path) -> anyhow::Result<Self> {
        let conn = Self::open_conn(path)?;
        Ok(Self {
            conn: Mutex::new(conn),
            demo: Mutex::new(DemoSlot::default()),
            real_path: path.to_path_buf(),
        })
    }

    /// Open a connection with DayApp's pragmas and schema migrations applied.
    /// Shared by the real db and the demo db — both must stay schema-identical,
    /// so migrations apply to either through the same path.
    pub(crate) fn open_conn(path: &std::path::Path) -> anyhow::Result<Connection> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        // The CLI (dayapp --list/--add/--complete) opens the same file while the
        // GUI is running — wait out each other's write locks instead of erroring.
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;     // crash-safe, fast
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Self::migrate(&conn)?;
        Ok(conn)
    }

    /// The launch sweep family: day-boundary sweep + reminder promotion (both
    /// inside run_sweep — promotion rides every sweep call, the frontend's
    /// 60s tick included, so a due reminder fires without a relaunch), and the
    /// expired-hide restores. Runs against whichever db is active — on every
    /// launch (real), and on every demo-mode toggle (each db behaves as if
    /// the app relaunched into it).
    pub fn launch_sweeps(&self) -> anyhow::Result<()> {
        let fell = self.run_sweep()?;
        if fell > 0 { log::info!("sweep: {fell} today item(s) fell to backlog"); }
        let purged = self.purge_completed_today()?;
        if purged > 0 { log::info!("sweep: {purged} completed today item(s) cleared"); }
        let ih = self.unhide_expired_items()?;
        let nh = self.unhide_expired_notes()?;
        let gh = self.unhide_expired_goals()?;
        if ih + nh + gh > 0 { log::info!("unhide sweep: {ih} item(s), {nh} note(s), {gh} goal(s) restored"); }
        Ok(())
    }

    fn migrate(conn: &Connection) -> anyhow::Result<()> {
        // Actions v2: goals log here too (goal_* action values, a nullable
        // item_id + a goal_id column — see schema.sql). SQLite can't ALTER a
        // CHECK constraint or a NOT NULL, so detect the old shape and rebuild
        // the table once, copying the whole history through. This runs BEFORE
        // the schema batch below — schema.sql creates idx_actions_goal, which
        // can't run against the pre-goals table shape. On a fresh db there is
        // no actions table yet and the schema batch creates v2 directly.
        let actions_exists = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'actions'",
                [], |_| Ok(()),
            )
            .optional()?
            .is_some();
        if actions_exists {
            let has_goal_col = {
                let mut stmt = conn.prepare("SELECT name FROM pragma_table_info('actions')")?;
                let names: Vec<String> = stmt
                    .query_map([], |r| r.get::<_, String>(0))?
                    .filter_map(|n| n.ok())
                    .collect();
                names.iter().any(|n| n == "goal_id")
            };
            if !has_goal_col {
                log::info!("migrate: rebuilding actions table to add goal logging");
                // Keep this definition in lockstep with schema.sql's `actions`.
                conn.execute_batch("
                    BEGIN;
                    CREATE TABLE actions_v2 (
                        id           INTEGER PRIMARY KEY AUTOINCREMENT,
                        item_id      TEXT,
                        goal_id      TEXT,
                        item_text    TEXT NOT NULL,
                        action       TEXT NOT NULL CHECK (action IN
                                      ('created','completed','uncompleted','moved',
                                       'edited','deleted','fell_to_backlog',
                                       'goal_created','goal_achieved','goal_unachieved',
                                       'goal_edited','goal_deleted')),
                        from_section TEXT, to_section TEXT,
                        from_status  TEXT, to_status  TEXT,
                        timestamp    TEXT NOT NULL,
                        CHECK (item_id IS NOT NULL OR goal_id IS NOT NULL)
                    );
                    INSERT INTO actions_v2
                        (id,item_id,goal_id,item_text,action,from_section,to_section,from_status,to_status,timestamp)
                    SELECT id,item_id,NULL,item_text,action,from_section,to_section,from_status,to_status,timestamp
                    FROM actions;
                    DROP TABLE actions;
                    ALTER TABLE actions_v2 RENAME TO actions;
                    CREATE INDEX IF NOT EXISTS idx_actions_ts     ON actions(timestamp);
                    CREATE INDEX IF NOT EXISTS idx_actions_item   ON actions(item_id);
                    CREATE INDEX IF NOT EXISTS idx_actions_action ON actions(action);
                    CREATE INDEX IF NOT EXISTS idx_actions_goal   ON actions(goal_id);
                    COMMIT;
                ")?;
            }
        }

        let schema = include_str!("../schema.sql");
        conn.execute_batch(schema)?;
        // schema.sql only creates new columns on fresh tables. For DBs created
        // before the hide feature existed, ALTER TABLE adds the columns
        // idempotently — PRAGMA table_info tells us which are missing.
        // ensure_column logs when it actually adds something, so we can see
        // migrations in the log without noise on steady-state launches.
        ensure_column(conn, "items", "hidden", "INTEGER NOT NULL DEFAULT 0")?;
        ensure_column(conn, "items", "hidden_until", "TEXT")?;
        ensure_column(conn, "items", "project_id", "TEXT")?;
        ensure_column(conn, "items", "remind_at", "TEXT")?;
        ensure_column(conn, "items", "priority", "INTEGER")?;
        ensure_column(conn, "items", "assigned_to_agent", "INTEGER NOT NULL DEFAULT 0")?;
        ensure_column(conn, "items", "details", "TEXT NOT NULL DEFAULT ''")?;
        ensure_column(conn, "notes", "hidden", "INTEGER NOT NULL DEFAULT 0")?;
        ensure_column(conn, "notes", "hidden_until", "TEXT")?;
        ensure_column(conn, "notes", "priority", "INTEGER")?;
        ensure_column(conn, "notes", "project_id", "TEXT")?;
        ensure_column(conn, "goals", "hidden", "INTEGER NOT NULL DEFAULT 0")?;
        ensure_column(conn, "goals", "hidden_until", "TEXT")?;
        // The dashboard's snapshot axes (see schema.sql). When the columns
        // land on an existing db, backfill once from then-current state — the
        // best guess available for history written before snapshots existed
        // (deleted subjects stay unattributed; honest best effort).
        if ensure_column(conn, "actions", "project", "TEXT")?
            | ensure_column(conn, "actions", "priority", "INTEGER")?
        {
            let n = backfill_action_axes(conn)?;
            log::info!("migrate: snapshotted project/priority onto {n} action row(s)");
        }
        // `agent` snapshots the delegation flag the same way — its absence was
        // the analytics bug where every completed agent task whose row had
        // been swept or unflagged read as the owner's (the axis used to read
        // the item's CURRENT flag through a subselect). Backfilled once from
        // the item's current flag; deleted subjects stay NULL and read as the
        // owner's — the same honest best effort as the other axes.
        if ensure_column(conn, "actions", "agent", "INTEGER")? {
            let n = conn.execute(
                "UPDATE actions SET agent = (
                     SELECT i.assigned_to_agent FROM items i WHERE i.id = actions.item_id)
                 WHERE agent IS NULL AND item_id IS NOT NULL",
                [],
            )?;
            log::info!("migrate: snapshotted agent onto {n} action row(s)");
        }
        // Actions v3: paused/unpaused — the dated record of an item's hide.
        // The daily-miss replay folds them instead of reading the hidden flag
        // (which can't say WHEN a pause started). Runs after the ensure_columns
        // above so the rebuild copies every current column through. Detected
        // off the stored CHECK: SQLite can't ALTER it, so the table is rebuilt
        // once and the whole history copied.
        let actions_exists = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'actions'",
                [], |_| Ok(()),
            )
            .optional()?
            .is_some();
        if actions_exists {
            let sql: String = conn.query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'actions'",
                [], |r| r.get(0),
            )?;
            if !sql.contains("'paused'") {
                log::info!("migrate: rebuilding actions table to add pause logging");
                let now = now_iso();
                // Keep this definition in lockstep with schema.sql's `actions`.
                let tx = conn.unchecked_transaction()?;
                tx.execute_batch("
                    CREATE TABLE actions_v3 (
                        id           INTEGER PRIMARY KEY AUTOINCREMENT,
                        item_id      TEXT,
                        goal_id      TEXT,
                        item_text    TEXT NOT NULL,
                        action       TEXT NOT NULL CHECK (action IN
                                      ('created','completed','uncompleted','moved',
                                       'edited','deleted','fell_to_backlog','paused','unpaused',
                                       'goal_created','goal_achieved','goal_unachieved',
                                       'goal_edited','goal_deleted')),
                        from_section TEXT, to_section TEXT,
                        from_status  TEXT, to_status  TEXT,
                        timestamp    TEXT NOT NULL,
                        project      TEXT,
                        priority     INTEGER,
                        agent        INTEGER,
                        CHECK (item_id IS NOT NULL OR goal_id IS NOT NULL)
                    );
                    INSERT INTO actions_v3
                        (id,item_id,goal_id,item_text,action,from_section,to_section,from_status,to_status,timestamp,project,priority,agent)
                    SELECT id,item_id,goal_id,item_text,action,from_section,to_section,from_status,to_status,timestamp,project,priority,agent
                    FROM actions;
                    DROP TABLE actions;
                    ALTER TABLE actions_v3 RENAME TO actions;
                    CREATE INDEX IF NOT EXISTS idx_actions_ts     ON actions(timestamp);
                    CREATE INDEX IF NOT EXISTS idx_actions_item   ON actions(item_id);
                    CREATE INDEX IF NOT EXISTS idx_actions_action ON actions(action);
                    CREATE INDEX IF NOT EXISTS idx_actions_goal   ON actions(goal_id);
                ")?;
                // Hides predating pause logging have no start date on record —
                // stamp a paused action at migration time. Their past days keep
                // their misses (the population before this point was never
                // paused), and the missed count stops accruing from here.
                let n = tx.execute(
                    "INSERT INTO actions (item_id,item_text,action,to_section,timestamp,project,priority)
                     SELECT id, text, 'paused', section, ?1,
                            (SELECT p.name FROM projects p WHERE p.id = items.project_id),
                            priority
                     FROM items WHERE hidden = 1",
                    params![now],
                )?;
                tx.commit()?;
                if n > 0 {
                    log::info!("migrate: logged paused for {n} hidden item(s)");
                }
            }
        }
        // Consume token lines an earlier footer-storing build left in note
        // bodies (see notes.rs) — idempotent, so this is silent from the
        // second open on.
        let consumed = crate::notes::consume_stored_note_footers(conn)?;
        if consumed > 0 {
            log::info!("migrate: consumed {consumed} stored note footer(s) into columns");
        }
        // The created-axis backfill: captures made by the old two-step path
        // (item created bare, tokens applied after) logged `created` actions
        // with NULL axes, so the analytics Created lens reads everything
        // unattributed. Fill them once from the items' CURRENT axes — the
        // same best effort the snapshot columns' backfill took (deleted
        // items stay unattributed). Meta-gated one-shot: a standing
        // statement would rewrite post-fix rows whose NULL birth axes are
        // legitimate (born untagged, assigned later).
        let flagged: bool = conn
            .query_row(
                "SELECT 1 FROM meta WHERE key = 'migrated_created_axes'",
                [], |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !flagged {
            let n = conn.execute(
                "UPDATE actions SET
                   project = (SELECT p.name FROM items i
                              LEFT JOIN projects p ON p.id = i.project_id
                              WHERE i.id = actions.item_id),
                   priority = (SELECT i.priority FROM items i WHERE i.id = actions.item_id),
                   agent = (SELECT i.assigned_to_agent FROM items i WHERE i.id = actions.item_id)
                 WHERE action = 'created' AND item_id IS NOT NULL
                   AND project IS NULL AND priority IS NULL
                   AND item_id IN (SELECT id FROM items)",
                [],
            )?;
            conn.execute(
                "INSERT INTO meta(key,value) VALUES('migrated_created_axes','1')
                 ON CONFLICT(key) DO UPDATE SET value = '1'",
                [],
            )?;
            if n > 0 {
                log::info!("migrate: backfilled birth axes onto {n} created action row(s)");
            }
        }
        Ok(())
    }

    pub fn meta_get(&self, key: &str) -> anyhow::Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let v = conn.query_row(
            "SELECT value FROM meta WHERE key = ?1", params![key], |r| r.get(0),
        ).optional()?;
        Ok(v)
    }

    pub fn meta_set(&self, key: &str, value: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO meta(key,value) VALUES(?1,?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value])?;
        Ok(())
    }

}

/// The hour the app's day flips. Matches lib.ts todayStr().
pub const DAY_START_HOUR: u32 = 6;

pub fn now_iso() -> String {
    use chrono::{Local, SecondsFormat};
    Local::now().to_rfc3339_opts(SecondsFormat::Secs, false)
}

/// The logical today as a NaiveDate: the local date of (now − 6h). Between
/// midnight and 06:00 this is yesterday.
pub fn today_naive() -> chrono::NaiveDate {
    use chrono::{Duration, Local};
    (Local::now() - Duration::hours(DAY_START_HOUR as i64)).date_naive()
}

pub fn today_iso() -> String {
    today_naive().format("%Y-%m-%d").to_string()
}

/// The logical day a now_iso() timestamp belongs to: shift back
/// DAY_START_HOUR before taking the date, so 02:00 keys to the previous day.
/// Naive wall-clock — DST edges ignored, like the rest of the date model.
pub fn day_key_of_ts(ts: &str) -> Option<String> {
    use chrono::{Duration, NaiveDateTime};
    let naive = NaiveDateTime::parse_from_str(ts.get(..19)?, "%Y-%m-%dT%H:%M:%S").ok()?;
    Some((naive - Duration::hours(DAY_START_HOUR as i64))
        .format("%Y-%m-%d")
        .to_string())
}

/// The wall-clock prefix where logical `day` begins — the SQL bound for
/// [day, …) scans over now_iso() timestamps. Lexicographic against the
/// RFC3339 form: `2026-09-04T05:00:00+05:00 < "2026-09-04T06:00:00"`, while
/// a timestamp at exactly 06:00:00 carries an offset suffix and sorts after.
pub fn day_start_prefix(day: &str) -> String {
    format!("{day}T{DAY_START_HOUR:02}:00:00")
}

// Map a hide duration to its expiry date (ISO YYYY-MM-DD), or None for forever.
// day/week/month land on the start of a future local date — they auto-restore
// at the day-boundary sweep, consistent with the rest of DayApp's reset model.
pub fn hidden_until_for(duration: &str) -> Option<String> {
    use chrono::{Duration, Months};
    let today = today_naive();
    let date = match duration {
        "day" => Some(today + Duration::days(1)),
        "week" => Some(today + Duration::days(7)),
        "month" => Some(today.checked_add_months(Months::new(1))?),
        _ => None, // "forever" (or anything unknown) → never auto-restore
    };
    // checked_add_months can fail at the edge of the representable range; fall
    // back to a 30-day offset so a bad input never silently hides forever.
    let date = match (duration, date) {
        ("month", None) => today + Duration::days(30),
        (_, d) => d?,
    };
    Some(date.format("%Y-%m-%d").to_string())
}

// Build an Item from a 15-column SELECT row (id..details).
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
pub(crate) fn backfill_action_axes(conn: &Connection) -> anyhow::Result<usize> {
    let n = conn.execute(
        "UPDATE actions SET
           project = (SELECT p.name FROM items i
                      LEFT JOIN projects p ON p.id = i.project_id
                      WHERE i.id = actions.item_id),
           priority = (SELECT i.priority FROM items i WHERE i.id = actions.item_id)
         WHERE item_id IS NOT NULL AND project IS NULL AND priority IS NULL",
        [])?;
    let g = conn.execute(
        "UPDATE actions SET
           project = (SELECT p.name FROM goals g
                      LEFT JOIN projects p ON p.id = g.project_id
                      WHERE g.id = actions.goal_id)
         WHERE goal_id IS NOT NULL AND project IS NULL",
        [])?;
    Ok(n + g)
}

// Add a column only if it isn't already on the table. Lets schema.sql stay
// declarative for fresh DBs while still upgrading pre-existing ones. Returns
// whether the column was added, so callers can run one-time follow-ups (like
// the actions project/priority backfill).
fn ensure_column(    conn: &Connection, table: &str, column: &str, decl: &str,
) -> anyhow::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let present: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect();
    if !present.iter().any(|c| c == column) {
        log::info!("migrate: adding column {table}.{column} ({decl})");
        conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"), [])?;
        Ok(true)
    } else {
        Ok(false)
    }
}

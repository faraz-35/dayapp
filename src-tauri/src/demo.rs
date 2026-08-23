// Demo mode — a second, disposable db swapped in for trying and showing the app.
//
// ⌘P → "Enter Demo Mode" swaps the active connection (Db::conn) to
// dayapp-demo.db, a sibling of the real file seeded from demo.sql (embedded at
// compile time, timestamps relative to seed day — see that file for the
// dataset). Every command keeps working untouched: they lock Db::conn and use
// whatever connection is inside, so the swap under the same mutex is atomic
// from a command's point of view. The parked side stays open for an instant
// swap back — a real timer left running keeps counting honestly the whole time.
//
// Rules the feature is built on (deliberate — don't relax them):
// - Demo MODE never persists across launches: every launch opens the real db.
//   The one exception is the first run — with no real db in place the app opens
//   straight into demo mode as the tour, and "Exit Demo Mode" is the on-ramp
//   to a clean, empty real db.
// - Demo DATA persists: mutations live in dayapp-demo.db across sessions, and
//   "Reset Demo Data" (⌘P, demo mode only) re-runs the seed.
// - Mobile sync is fully gated while demo is active (see sync.rs) — demo tasks
//   must never reach the phone mirror, and the phone's captures wait for exit.
//
// The CLI opens the demo db directly via `Db::open_demo` (`dayapp --demo --list`).

use crate::db::{Db, DemoSlot};
use rusqlite::Connection;
use std::path::{Path, PathBuf};

/// The demo db's path — a sibling of the real one (same app-support dir, so
/// WAL/busy_timeout and the CLI's path resolution work identically).
pub fn demo_db_path(real_path: &Path) -> PathBuf {
    real_path.with_file_name("dayapp-demo.db")
}

/// Run the demo seed against a connection: wipe every table and insert the
/// sample dataset. `Reset Demo Data` is exactly this; first-use creation runs
/// it once on a fresh file. schema.sql has already run (Db::open_conn), so
/// this script is pure content.
pub fn seed(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(include_str!("../demo.sql"))?;
    Ok(())
}

/// Open the demo db for `real_path`, creating + seeding it on first use.
/// Existing demo files just migrate (schema drift is handled like the real db);
/// data is never auto-reset — that's the explicit ⌘P command.
fn open_demo_conn(real_path: &Path) -> anyhow::Result<Connection> {
    let path = demo_db_path(real_path);
    let fresh = !path.exists();
    let conn = Db::open_conn(&path)?;
    if fresh {
        seed(&conn)?;
        log::info!("demo: seeded demo db ({})", path.display());
    }
    Ok(conn)
}

impl Db {
    /// A Db opened straight into demo mode — the CLI's `--demo` path. The real
    /// db isn't opened at all (parked stays None; exit_demo would open it
    /// lazily if ever asked).
    pub fn open_demo(real_path: &Path) -> anyhow::Result<Self> {
        let conn = open_demo_conn(real_path)?;
        Ok(Self {
            conn: std::sync::Mutex::new(conn),
            demo: std::sync::Mutex::new(DemoSlot { active: true, parked: None }),
            real_path: real_path.to_path_buf(),
        })
    }

    /// Whether the active connection is the demo db.
    pub fn is_demo(&self) -> bool {
        self.demo.lock().unwrap().active
    }

    /// Swap to the demo db (no-op if already there). Opening/seeding happens
    /// outside every lock; the swap itself is a mem::replace under the
    /// connection lock, so no command can observe a half-swapped state.
    /// Afterwards the launch sweeps run against the demo db — a demo db left
    /// untouched for days rolls its day boundary here, exactly like a
    /// relaunch would.
    pub fn enter_demo(&self) -> anyhow::Result<()> {
        if self.is_demo() {
            return Ok(());
        }
        let demo_conn = open_demo_conn(&self.real_path)?;
        let mut slot = self.demo.lock().unwrap();
        if slot.active {
            return Ok(()); // a concurrent enter won the race
        }
        let mut conn = self.conn.lock().unwrap();
        slot.parked = Some(std::mem::replace(&mut *conn, demo_conn));
        slot.active = true;
        drop(conn);
        drop(slot);
        self.launch_sweeps()?;
        log::info!("demo: entered demo mode");
        Ok(())
    }

    /// Swap back to the real db (no-op if not in demo). The parked real
    /// connection returns instantly (reopened from disk if the process started
    /// straight into demo, as the CLI does); the demo connection is parked in
    /// its place, open for the next entry. The launch sweeps run against the
    /// real db afterwards — it may have crossed a day boundary while the app
    /// sat in demo mode.
    pub fn exit_demo(&self) -> anyhow::Result<()> {
        let mut slot = self.demo.lock().unwrap();
        if !slot.active {
            return Ok(());
        }
        let real = match slot.parked.take() {
            Some(c) => c,
            None => Db::open_conn(&self.real_path)?,
        };
        let mut conn = self.conn.lock().unwrap();
        slot.parked = Some(std::mem::replace(&mut *conn, real));
        slot.active = false;
        drop(conn);
        drop(slot);
        self.launch_sweeps()?;
        log::info!("demo: exited demo mode");
        Ok(())
    }

    /// Re-run the demo seed (⌘P → "Reset Demo Data", demo mode only). The
    /// active connection IS the demo db while in demo mode, so seeding it in
    /// place is enough; seeded history is dated relative to today, so a reset
    /// is also the way to freshen a demo that has aged.
    pub fn reset_demo(&self) -> anyhow::Result<()> {
        {
            let slot = self.demo.lock().unwrap();
            if !slot.active {
                anyhow::bail!("demo data can only be reset while in demo mode");
            }
        }
        let conn = self.conn.lock().unwrap();
        seed(&conn)?;
        drop(conn);
        log::info!("demo: re-seeded demo data");
        Ok(())
    }
}

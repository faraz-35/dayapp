// Point-in-time backups of the real db (⌘P → Backups: Capture Now /
// dayapp --backup). Capture-only by design — there is no restore surface yet;
// restoring means quitting the app and swapping the file by hand.
//
// Mechanism: SQLite's `VACUUM INTO 'file'` run through the ACTIVE connection,
// producing a fresh timestamped file under backups/ beside the db. The
// statement copies a transactionally-consistent snapshot of the whole database
// (WAL content included) into a single compacted, standalone file while other
// connections (the CLI) keep writing — no -wal/-shm files travel with it, so
// the snapshot can be copied or archived anywhere as-is.
//
// Gated in demo mode like mobile sync: this feature protects the REAL data,
// and a snapshot of the seeded sample db would masquerade as one.
//
// No retention policy: every capture is a deliberate act (nothing runs
// automatically), the db is small, and deleting backups unprompted is worse
// than keeping them.

use crate::db::Db;
use std::path::{Path, PathBuf};

/// The backups folder — `backups/` beside the real db.
pub fn backups_dir(real_path: &Path) -> PathBuf {
    real_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("backups")
}

/// Snapshot the active-when-called real db into backups/ and return the new
/// file's path. Refuses while demo mode is active.
pub fn capture(db: &Db) -> anyhow::Result<PathBuf> {
    if db.is_demo() {
        anyhow::bail!("backups protect the real db — exit demo mode first");
    }
    let dir = backups_dir(&db.real_path);
    std::fs::create_dir_all(&dir)?;

    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let dest = dir.join(format!("dayapp-{stamp}.db"));
    // Per-process scratch name: VACUUM INTO refuses an existing target, and a
    // GUI capture racing a CLI capture must not stomp each other's partial.
    let tmp = dir.join(format!(".backup-{}.tmp", std::process::id()));

    {
        let conn = db.conn.lock().unwrap();
        conn.execute("VACUUM INTO ?1", rusqlite::params![tmp.to_string_lossy()])?;
    }
    // Atomic within backups/, so `dest` either doesn't exist or is complete —
    // a failed run never leaves a half-written file looking like a good backup.
    std::fs::rename(&tmp, &dest)?;
    log::info!(
        "backup: captured {} ({})",
        dest.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(),
        fmt_size(std::fs::metadata(&dest)?.len()),
    );
    Ok(dest)
}

/// Open the backups folder in Finder, creating it first so the reveal works
/// even before the first capture.
pub fn reveal(real_path: &Path) -> anyhow::Result<()> {
    let dir = backups_dir(real_path);
    std::fs::create_dir_all(&dir)?;
    std::process::Command::new("open").arg(&dir).spawn()?;
    log::info!("backup: revealed backups folder");
    Ok(())
}

fn fmt_size(bytes: u64) -> String {
    if bytes >= 1_048_576 {
        format!("{:.1} MB", bytes as f64 / 1_048_576.0)
    } else if bytes >= 1024 {
        format!("{:.0} KB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes} B")
    }
}

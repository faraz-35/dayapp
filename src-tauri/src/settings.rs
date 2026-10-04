// Settings store — every persisted UI preference (features, toggles, themes,
// views) lives in `settings.json` beside the databases, NOT in the webview's
// localStorage. One file, two writers: the GUI (via the commands below) and
// the CLI (`dayapp --settings` / theme / view verbs), so an agent session can
// manage the app's configuration over SSH exactly like its tasks. App-level
// by position: the file sits outside dayapp.db / dayapp-demo.db, so demo-mode
// swaps never touch it — settings are the app's, not a database's.
//
// Shape: a flat map of the old localStorage keys to their string values. The
// JSON-valued keys (themes, views, header buttons) store the JSON string —
// the GUI's state code moved over unchanged, only its persistence calls
// swapped. Writes are read-modify-write under a process lock and land via
// temp-file + atomic rename, safe against the two processes racing.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static LOCK: Mutex<()> = Mutex::new(());

/// `settings.json` beside the given db path.
pub fn path_for(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .map(|d| d.join("settings.json"))
        .unwrap_or_else(|| PathBuf::from("settings.json"))
}

/// The whole map. A missing file is an empty map — every reader applies its
/// own default, so first run needs no seeding.
pub fn read(db_path: &Path) -> anyhow::Result<HashMap<String, String>> {
    let path = path_for(db_path);
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let raw = std::fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

/// Set one key. Read-modify-write so a CLI key-set never clobbers keys the
/// GUI wrote between its read and write.
pub fn set(db_path: &Path, key: &str, value: &str) -> anyhow::Result<()> {
    let _guard = LOCK.lock().unwrap();
    let mut map = read(db_path)?;
    map.insert(key.to_string(), value.to_string());
    write(&path_for(db_path), &map)
}

/// Set many keys in one locked pass (the GUI's bulk-persist effect).
pub fn set_many(db_path: &Path, entries: HashMap<String, String>) -> anyhow::Result<()> {
    let _guard = LOCK.lock().unwrap();
    let mut map = read(db_path)?;
    for (k, v) in entries {
        map.insert(k, v);
    }
    write(&path_for(db_path), &map)
}

fn write(path: &Path, map: &HashMap<String, String>) -> anyhow::Result<()> {
    let json = serde_json::to_string_pretty(map)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

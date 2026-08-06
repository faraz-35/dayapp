// Tauri app entry. Thin async command wrappers around the db layer.
// DB work (rusqlite is sync) is dispatched to a blocking thread so the UI stays fluid.

mod db;

use db::{Db, Item, Action};
use std::sync::Arc;
use tauri::{Manager, State};

fn db_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    // ~/Library/Application Support/DayApp/dayapp.db on macOS.
    let dir = app.path().app_data_dir().expect("app data dir");
    dir.join("dayapp.db")
}

/// Clone the inner Arc<Db> out of State and run a closure on a blocking thread.
/// Tauri commands can't return `anyhow::Error` (it isn't Serialize), so the closure's
/// anyhow result is stringified into a plain `Result<T, String>` for IPC.
async fn with_db<F, R>(state: State<'_, DbState>, f: F) -> Result<R, String>
where
    F: FnOnce(Arc<Db>) -> anyhow::Result<R> + Send + 'static,
    R: Send + 'static,
{
    let db = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || f(db))
        .await
        .map_err(|e| format!("task join error: {e}"))?
        .map_err(|e| format!("{e:#}"))
}

struct DbState(Arc<Db>);

// ---- Tauri commands -------------------------------------------------------

#[tauri::command]
async fn list_items(db: State<'_, DbState>, section: String, include_done: bool)
    -> Result<Vec<Item>, String>
{
    with_db(db, move |db| db.list(&section, include_done)).await
}

#[tauri::command]
async fn create_item(db: State<'_, DbState>, text: String, section: String)
    -> Result<Item, String>
{
    with_db(db, move |db| db.create_item(&text, &section)).await
}

#[tauri::command]
async fn edit_item(db: State<'_, DbState>, id: String, text: String)
    -> Result<(), String>
{
    with_db(db, move |db| db.edit_item(&id, &text)).await
}

#[tauri::command]
async fn complete_item(db: State<'_, DbState>, id: String) -> Result<(), String> {
    with_db(db, move |db| db.complete_item(&id)).await
}

#[tauri::command]
async fn move_item(db: State<'_, DbState>, id: String, to_section: String, new_index: i64)
    -> Result<(), String>
{
    with_db(db, move |db| db.move_item(&id, &to_section, new_index)).await
}

#[tauri::command]
async fn delete_item(db: State<'_, DbState>, id: String) -> Result<(), String> {
    with_db(db, move |db| db.delete_item(&id)).await
}

#[tauri::command]
async fn run_sweep(db: State<'_, DbState>) -> Result<usize, String> {
    with_db(db, move |db| db.run_sweep()).await
}

#[tauri::command]
async fn list_actions(db: State<'_, DbState>, limit: Option<i64>) -> Result<Vec<Action>, String> {
    with_db(db, move |db| db.list_actions(limit)).await
}

#[tauri::command]
async fn count_completions(db: State<'_, DbState>, since: String) -> Result<i64, String> {
    with_db(db, move |db| db.count_completions(&since)).await
}

// ---- Setup ----------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let db = Db::open(&db_path(app.handle()))?;
            // Today → Backlog sweep on every launch. Idempotent — cheap if already run today.
            let _ = db.run_sweep()?;
            app.manage(DbState(Arc::new(db)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_items, create_item, edit_item, complete_item,
            move_item, delete_item, run_sweep,
            list_actions, count_completions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DayApp");
}

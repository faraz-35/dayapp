// Tauri app entry. Thin async command wrappers around the db layer.
// DB work (rusqlite is sync) is dispatched to a blocking thread so the UI stays fluid.

mod db;
mod notes;
mod projects;

use db::{Db, Item, Action};
use notes::Note;
use projects::Project;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_log::{Target, TargetKind};

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

// ---- Hide commands (items) -----------------------------------------------
// Soft-archive: hidden=1 keeps the row but `list_items` excludes it. Not logged
// to `actions` — hide is housekeeping, not meaningful activity.

#[tauri::command]
async fn hide_item(db: State<'_, DbState>, id: String, duration: String)
    -> Result<(), String>
{
    with_db(db, move |db| db.hide_item(&id, &duration)).await
}

#[tauri::command]
async fn unhide_item(db: State<'_, DbState>, id: String) -> Result<(), String> {
    with_db(db, move |db| db.unhide_item(&id)).await
}

#[tauri::command]
async fn list_hidden_items(db: State<'_, DbState>) -> Result<Vec<Item>, String> {
    with_db(db, move |db| db.list_hidden_items()).await
}

#[tauri::command]
async fn run_sweep(db: State<'_, DbState>) -> Result<usize, String> {
    with_db(db, move |db| db.run_sweep()).await
}

#[tauri::command]
async fn list_actions(
    db: State<'_, DbState>, limit: Option<i64>,
    since: Option<String>, until: Option<String>,
) -> Result<Vec<Action>, String> {
    with_db(db, move |db| db.list_actions(limit, since.as_deref(), until.as_deref())).await
}

#[tauri::command]
async fn count_completions(db: State<'_, DbState>, since: String) -> Result<i64, String> {
    with_db(db, move |db| db.count_completions(&since)).await
}

// ---- Notes commands ------------------------------------------------------
// Separate from items. Notes are content (not activity), so no journal logging.

#[tauri::command]
async fn list_notes(db: State<'_, DbState>) -> Result<Vec<Note>, String> {
    with_db(db, move |db| db.list_notes()).await
}

#[tauri::command]
async fn create_note(db: State<'_, DbState>) -> Result<Note, String> {
    with_db(db, move |db| db.create_note()).await
}

#[tauri::command]
async fn update_note(db: State<'_, DbState>, id: String, body: String) -> Result<(), String> {
    with_db(db, move |db| db.update_note(&id, &body)).await
}

#[tauri::command]
async fn delete_note(db: State<'_, DbState>, id: String) -> Result<(), String> {
    with_db(db, move |db| db.delete_note(&id)).await
}

#[tauri::command]
async fn hide_note(db: State<'_, DbState>, id: String, duration: String)
    -> Result<(), String>
{
    with_db(db, move |db| db.hide_note(&id, &duration)).await
}

#[tauri::command]
async fn unhide_note(db: State<'_, DbState>, id: String) -> Result<(), String> {
    with_db(db, move |db| db.unhide_note(&id)).await
}

#[tauri::command]
async fn list_hidden_notes(db: State<'_, DbState>) -> Result<Vec<Note>, String> {
    with_db(db, move |db| db.list_hidden_notes()).await
}

// ---- Project commands ----------------------------------------------------
// A second organising axis alongside Sections. Assignment is housekeeping, so
// none of these are logged to `actions` — the journal stays focused on
// completion/movement.

#[tauri::command]
async fn list_projects(db: State<'_, DbState>) -> Result<Vec<Project>, String> {
    with_db(db, move |db| db.list_projects()).await
}

#[tauri::command]
async fn create_project(db: State<'_, DbState>, name: String) -> Result<Project, String> {
    with_db(db, move |db| db.create_project(&name)).await
}

#[tauri::command]
async fn rename_project(db: State<'_, DbState>, id: String, name: String) -> Result<(), String> {
    with_db(db, move |db| db.rename_project(&id, &name)).await
}

#[tauri::command]
async fn delete_project(db: State<'_, DbState>, id: String) -> Result<(), String> {
    with_db(db, move |db| db.delete_project(&id)).await
}

#[tauri::command]
async fn set_item_project(
    db: State<'_, DbState>, id: String, project_id: Option<String>,
) -> Result<(), String> {
    with_db(db, move |db| db.set_item_project(&id, project_id.as_deref())).await
}

#[tauri::command]
async fn set_reminder(
    db: State<'_, DbState>, id: String, remind_at: Option<String>,
) -> Result<(), String> {
    with_db(db, move |db| db.set_reminder(&id, remind_at.as_deref())).await
}

// ---- Self-update ---------------------------------------------------------
//
// In-app "rebuild and relaunch" — no Terminal, no dragging. Runs the build in
// process so the UI can stream progress; on success, spawns the swap helper
// detached and exits the app so the bundle can be replaced. The build path is
// embedded at compile time (CARGO_MANIFEST_DIR), so this needs zero config.
//
// Emits "update-status" events to the window:
//   { phase: "building", line }     — one per stdout/stderr line from the build
//   { phase: "restarting" }          — build OK, about to exit
//   { phase: "error", message }      — build failed; app stays running
//
// npm is invoked with stdbuf to line-buffer, and every line is emitted as it
// arrives so the user sees live compiler output. `npm run tauri build` returns
// non-zero on any failure, which we surface as an error event and stay alive.

#[tauri::command]
async fn self_update(app: AppHandle) -> Result<(), String> {
    use std::process::{Command, Stdio};
    use std::io::{BufRead, BufReader};

    // CARGO_MANIFEST_DIR = .../src-tauri. The repo root (where package.json +
    // scripts/ live) is its parent.
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let repo_root = std::path::Path::new(manifest_dir).parent().ok_or("no parent")?;

    log::info!("self_update: starting build in {}", repo_root.display());

    let emit = |phase: &str, data: &str| {
        let _ = app.emit("update-status", serde_json::json!({ "phase": phase, "data": data }));
    };

    // Run `npm run tauri build`, streaming every line to the UI as it arrives.
    // stdout+stderr are merged (piped together) so ordering matches a terminal.
    let mut child = Command::new("npm")
        .args(["run", "tauri", "build"])
        .current_dir(repo_root)
        .env("FORCE_COLOR", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            log::error!("self_update: failed to start build: {e}");
            format!("failed to start build: {e}")
        })?;

    // Merge stderr into stdout by dup'ing the pipe: read stdout line-by-line
    // on this task, and drain stderr on a spawned thread piping into the same
    // channel via a shared emitter. Simpler: read both with a thread each.
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let app2 = app.clone();
    let stderr_handle = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            let _ = app2.emit("update-status", serde_json::json!({ "phase": "building", "data": line }));
        }
    });

    let stdout_reader = BufReader::new(stdout);
    for line in stdout_reader.lines().flatten() {
        emit("building", &line);
    }
    let _ = stderr_handle.join();
    let status = child.wait().map_err(|e| format!("failed to wait for build: {e}"))?;

    if !status.success() {
        let code = status.code().unwrap_or(-1);
        log::error!("self_update: build failed (exit {code})");
        emit("error", &format!("build failed (exit {code})"));
        return Ok(()); // app stays alive; user dismissed via the error overlay
    }
    log::info!("self_update: build succeeded");

    // Success — hand off to the detached swap helper, then exit. The helper
    // waits for us to quit, replaces the bundle, and reopens the app.
    emit("restarting", "");
    let script = repo_root.join("scripts").join("update.sh");
    log::info!("self_update: spawning swap helper (detached): {}", script.display());
    use std::os::unix::process::CommandExt;
    let mut helper = Command::new("/bin/bash");
    helper.arg(&script)
        .arg("--swap-only")
        .current_dir(repo_root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Detach into a new session so the helper survives the app exiting.
        // Without setsid, macOS may tear the child down with the parent.
        .process_group(0);
    let _pid = helper.spawn().map_err(|e| {
        log::error!("self_update: failed to start swap helper: {e}");
        format!("failed to start swap helper: {e}")
    })?;

    // Give the helper a beat to get into its wait-for-quit loop, then exit. The
    // window disappears momentarily and reappears once the new app opens.
    log::info!("self_update: exiting app to let swap helper proceed");
    std::thread::sleep(std::time::Duration::from_millis(1200));
    app.exit(0);
    Ok(())
}

// ---- Setup ----------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            // Logs to a rotating file in the app log dir AND stdout. The webview
            // can also emit via the JS `log` plugin, but we keep it backend-only
            // to avoid log noise in the devtools console. See AGENTS.md for the
            // logging convention.
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: None }),
                    Target::new(TargetKind::Webview),
                ])
                // Our own logs at Info; silence the chatty windowing/runtime crates
                // so the log file is signal, not tao's per-frame TRACE noise.
                .level(log::LevelFilter::Info)
                .level_for("tao", log::LevelFilter::Warn)
                .level_for("wry", log::LevelFilter::Warn)
                .level_for("tauri", log::LevelFilter::Info)
                .level_for("rustls", log::LevelFilter::Warn)
                .level_for("hyper", log::LevelFilter::Warn)
                .build(),
        )
        .setup(|app| {
            log::info!("DayApp starting (version {})", app.package_info().version);
            let db_path = db_path(app.handle());
            log::debug!("db path: {}", db_path.display());
            let db = Db::open(&db_path)?;
            // Today → Backlog sweep on every launch. Idempotent — cheap if already run today.
            let fell = db.run_sweep()?;
            if fell > 0 { log::info!("sweep: {fell} today item(s) fell to backlog"); }
            // Restore any items/notes whose time-limited hide expired. Runs
            // independently of run_sweep's once-per-day guard so expired hides
            // clear even if the day-boundary sweep already ran.
            let ih = db.unhide_expired_items()?;
            let nh = db.unhide_expired_notes()?;
            if ih + nh > 0 { log::info!("unhide sweep: {ih} item(s), {nh} note(s) restored"); }
            // Promote any backlog items whose reminder date has come due. Un-gated
            // (idempotent) so it runs on every launch, independent of the day sweep.
            let rp = db.promote_due_reminders()?;
            if rp > 0 { log::info!("reminders: {rp} backlog item(s) promoted to today"); }
            // Ensure at least one empty note exists — zero-inertia landing surface.
            let _ = db.ensure_seed_note()?;
            app.manage(DbState(Arc::new(db)));
            log::info!("DayApp ready");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_items, create_item, edit_item, complete_item,
            move_item, delete_item, run_sweep,
            hide_item, unhide_item, list_hidden_items,
            list_actions, count_completions,
            list_notes, create_note, update_note, delete_note,
            hide_note, unhide_note, list_hidden_notes,
            list_projects, create_project, rename_project, delete_project, set_item_project,
            set_reminder,
            self_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DayApp");
}

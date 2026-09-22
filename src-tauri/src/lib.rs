// Tauri app entry. Thin async command wrappers around the db layer.
// DB work (rusqlite is sync) is dispatched to a blocking thread so the UI stays fluid.

mod backup;
mod dashboard;
mod db;
mod demo;
mod goals;
mod journal;
mod notes;
mod projects;
mod sync;
mod timers;
pub mod cli;

use dashboard::DashboardStats;
use db::{Db, HiddenFilter, Item, Action};
use goals::Goal;
use notes::Note;
use projects::Project;
use std::sync::Arc;
use sync::{Capture, SyncConfig, SyncStatus};
use timers::{ActiveTimer, DayTaskTime};
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
async fn list_items(
    db: State<'_, DbState>, section: String, include_done: bool, hidden: HiddenFilter,
) -> Result<Vec<Item>, String>
{
    with_db(db, move |db| db.list(&section, include_done, hidden)).await
}

#[tauri::command]
async fn create_item(
    db: State<'_, DbState>, text: String, section: String,
    projectId: Option<String>, priority: Option<i64>,
) -> Result<Item, String>
{
    with_db(db, move |db| {
        db.create_item(&text, &section, projectId.as_deref(), priority)
    })
    .await
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
async fn uncomplete_item(db: State<'_, DbState>, id: String) -> Result<(), String> {
    with_db(db, move |db| db.uncomplete_item(&id)).await
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
// Soft-archive: hidden=1 keeps the row but the default `list_items` filter
// excludes it. Not logged to `actions` — hide is housekeeping, not meaningful
// activity.

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

// The Journal view's dashboard: the subject's counts per day (Done =
// effective completions with the miss verdicts, Created = the tasks that
// entered the list), a heatmap window, and project/priority splits — pure
// synthesis over `actions` (see dashboard.rs). `filter` scopes every
// derivation to the selected projects/tiers (None = unfiltered, the CLI's
// view). Read-only, like the journal itself.
#[tauri::command]
async fn journal_dashboard(
    db: State<'_, DbState>, since: Option<String>, until: Option<String>,
    filter: Option<dashboard::ScopeFilter>, subject: dashboard::Subject,
) -> Result<DashboardStats, String> {
    let filter = filter.unwrap_or_default();
    with_db(db, move |db| {
        db.journal_dashboard(since.as_deref(), until.as_deref(), &filter, subject)
    })
    .await
}

// One day at task level — what the analytics day card renders, for either
// subject. The per-task session seconds are layered on here in Done mode (a
// separate dimension; day_detail itself never touches `sessions`, and time
// deliberately doesn't follow the scope filter — see dashboard.rs).
#[tauri::command]
async fn journal_day_detail(
    db: State<'_, DbState>, date: String,
    filter: Option<dashboard::ScopeFilter>, subject: dashboard::Subject,
) -> Result<dashboard::DayDetail, String> {
    let filter = filter.unwrap_or_default();
    with_db(db, move |db| {
        let mut detail = db.day_detail(&date, &filter, subject)?;
        if subject == dashboard::Subject::Done {
            let next = dashboard::next_day(&date)?;
            let times = db.session_time_by_day(Some(date.as_str()), Some(next.as_str()))?;
            let by_item: std::collections::HashMap<String, i64> =
                times.into_iter().map(|t| (t.item_id, t.seconds)).collect();
            for t in &mut detail.tasks {
                t.secs = by_item.get(&t.item_id).copied().unwrap_or(0);
            }
        }
        Ok(detail)
    })
    .await
}

// ---- Notes commands ------------------------------------------------------
// Separate from items. Notes are content (not activity), so no journal logging.

#[tauri::command]
async fn list_notes(db: State<'_, DbState>, hidden: HiddenFilter) -> Result<Vec<Note>, String> {
    with_db(db, move |db| db.list_notes(hidden)).await
}

#[tauri::command]
async fn create_note(db: State<'_, DbState>, body: String) -> Result<Note, String> {
    with_db(db, move |db| db.create_note(&body)).await
}

#[tauri::command]
async fn update_note(db: State<'_, DbState>, id: String, body: String) -> Result<(), String> {
    with_db(db, move |db| db.update_note(&id, &body)).await
}

#[tauri::command]
async fn set_note_priority(
    db: State<'_, DbState>, id: String, priority: Option<i64>,
) -> Result<(), String> {
    with_db(db, move |db| db.set_note_priority(&id, priority)).await
}

#[tauri::command]
async fn set_note_project(
    db: State<'_, DbState>, id: String, projectId: Option<String>,
) -> Result<(), String> {
    with_db(db, move |db| db.set_note_project(&id, projectId.as_deref())).await
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

/// Save plain text through the native save panel (the note-export ⬇ button).
/// Returns false when the user cancels the panel — a cancel isn't an error.
/// Content export, not db state: nothing touches the db or `actions`; one info
/// line records the completed flow (the logging convention's only addition —
/// routine CRUD stays unlogged).
#[tauri::command]
async fn save_text_file(default_name: String, contents: String) -> Result<bool, String> {
    // rfd's async API dispatches the panel to the main thread itself, which is
    // why this runs as a plain async command instead of through with_db.
    let Some(handle) = rfd::AsyncFileDialog::new()
        .set_file_name(&default_name)
        .save_file()
        .await
    else {
        return Ok(false);
    };
    let path = handle.path().to_path_buf();
    std::fs::write(&path, contents).map_err(|e| format!("write failed: {e}"))?;
    log::info!(
        "notes: exported \"{}\"",
        path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default()
    );
    Ok(true)
}

// ---- Dev log (the demo-mode interaction trace) ----------------------------
// While the dev log records (auto-armed in demo mode, ⌘P-toggleable), the
// frontend ships batches of JSONL interaction events — captures, focus
// changes, edits, drags, palette runs — and this sink appends them to the
// named file in the app log dir (the same dir the rotating app log lives
// in). Deliberately a dumb transport: the event vocabulary lives in
// src/devlog.ts, nothing reads the file back, no db, no `actions` — a
// session-scoped debug artifact for agents (tail it) and the studio
// (subtitle cue sheets), safe to delete.

fn append_devlog_lines(dir: &std::path::Path, file: &str, lines: &[String]) -> Result<(), String> {
    // The name is generated by the frontend, but the sink stays defensive —
    // nothing path-shaped ever gets written.
    if file.is_empty() || file.contains('/') || file.contains('\\') || file.contains("..") {
        return Err(format!("bad devlog file name: {file}"));
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(file))
        .map_err(|e| format!("devlog open failed: {e}"))?;
    for line in lines {
        // One event per line. JSON.stringify never emits raw newlines, but a
        // malformed line must not corrupt the stream for its tail.
        writeln!(f, "{}", line.replace('\n', " "))
            .map_err(|e| format!("devlog write failed: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn devlog_append(app: AppHandle, file: String, lines: Vec<String>) -> Result<(), String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    append_devlog_lines(&dir, &file, &lines)
}

#[cfg(test)]
mod devlog_tests {
    use super::append_devlog_lines;

    #[test]
    fn appends_one_event_per_line_and_refuses_path_shaped_names() {
        let dir = std::env::temp_dir().join(format!("dayapp-devlog-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        append_devlog_lines(
            &dir,
            "devlog-test.jsonl",
            &[
                r#"{"t":0,"kind":"devlog.start"}"#.to_string(),
                // An embedded newline must flatten, not split the file
                // mid-event: one shipped event = one file line.
                "{\"t\":1.2,\"kind\":\"x\"}\n{\"t\":2,\"kind\":\"y\"}".to_string(),
            ],
        )
        .unwrap();
        let body = std::fs::read_to_string(dir.join("devlog-test.jsonl")).unwrap();
        assert_eq!(body.lines().count(), 2);
        assert!(append_devlog_lines(&dir, "../evil.jsonl", &[r#"{}"#.to_string()]).is_err());
        assert!(!dir.join("evil.jsonl").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ---- Entry commands (the ##j/##q typed capture) ---------------------------
// The notes bus's other destination: a leading `##j`/`##q` token in the Notes
// capture bar routes the line to the `entries` table (journal entries → the
// Journal view, quotes → the rotating line). Content like notes — never
// logged to `actions` (see journal.rs).

#[tauri::command]
async fn list_entries(db: State<'_, DbState>) -> Result<Vec<journal::Entry>, String> {
    with_db(db, move |db| db.list_entries()).await
}

#[tauri::command]
async fn add_entry(db: State<'_, DbState>, kind: String, text: String)
    -> Result<journal::Entry, String>
{
    with_db(db, move |db| db.add_entry(&kind, &text)).await
}

#[tauri::command]
async fn update_entry(db: State<'_, DbState>, id: String, text: String) -> Result<(), String> {
    with_db(db, move |db| db.update_entry(&id, &text)).await
}

#[tauri::command]
async fn delete_entry(db: State<'_, DbState>, id: String) -> Result<(), String> {
    with_db(db, move |db| db.delete_entry(&id)).await
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

#[tauri::command]
async fn set_item_priority(
    db: State<'_, DbState>, id: String, priority: Option<i64>,
) -> Result<(), String> {
    if let Some(p) = priority {
        if !(1..=3).contains(&p) {
            return Err(format!("priority must be 1, 2, or 3 (got {p})"));
        }
    }
    with_db(db, move |db| db.set_item_priority(&id, priority)).await
}

#[tauri::command]
async fn set_item_agent(
    db: State<'_, DbState>, id: String, assigned: bool,
) -> Result<(), String> {
    with_db(db, move |db| db.set_item_agent(&id, assigned)).await
}

#[tauri::command]
async fn set_item_details(
    db: State<'_, DbState>, id: String, details: String,
) -> Result<(), String> {
    with_db(db, move |db| db.set_item_details(&id, &details)).await
}

// ---- Goal commands -------------------------------------------------------
// The identity layer: horizon-scoped goals (short / long / timeless) above the
// task sections, optionally linked to a project. Like items, goals are state +
// logged activity — every mutation appends to `actions` (goal_* values); only
// the project link is housekeeping (unlogged).

#[tauri::command]
async fn list_goals(db: State<'_, DbState>) -> Result<Vec<Goal>, String> {
    with_db(db, move |db| db.list_goals()).await
}

#[tauri::command]
async fn create_goal(
    db: State<'_, DbState>, text: String, horizon: String, project_id: Option<String>,
) -> Result<Goal, String>
{
    with_db(db, move |db| db.create_goal(&text, &horizon, project_id.as_deref())).await
}

#[tauri::command]
async fn edit_goal(
    db: State<'_, DbState>, id: String, text: String, horizon: Option<String>,
) -> Result<(), String>
{
    with_db(db, move |db| db.edit_goal(&id, &text, horizon.as_deref())).await
}

#[tauri::command]
async fn set_goal_project(
    db: State<'_, DbState>, id: String, project_id: Option<String>,
) -> Result<(), String>
{
    with_db(db, move |db| db.set_goal_project(&id, project_id.as_deref())).await
}

#[tauri::command]
async fn achieve_goal(db: State<'_, DbState>, id: String) -> Result<(), String> {
    with_db(db, move |db| db.achieve_goal(&id)).await
}

#[tauri::command]
async fn unachieve_goal(db: State<'_, DbState>, id: String) -> Result<(), String> {
    with_db(db, move |db| db.unachieve_goal(&id)).await
}

#[tauri::command]
async fn delete_goal(db: State<'_, DbState>, id: String) -> Result<(), String> {
    with_db(db, move |db| db.delete_goal(&id)).await
}

// ---- Timer commands -----------------------------------------------------
// Per-task time tracking via single-active-timer sessions. Sessions are
// measurement (not item-state transitions), so — like notes/projects — they are
// never logged to `actions`; the journal reads them via session_time_by_day.

#[tauri::command]
async fn start_timer(db: State<'_, DbState>, item_id: String) -> Result<ActiveTimer, String> {
    with_db(db, move |db| db.start_timer(&item_id)).await
}

#[tauri::command]
async fn stop_timer(db: State<'_, DbState>) -> Result<(), String> {
    with_db(db, move |db| db.stop_timer()).await
}

#[tauri::command]
async fn discard_timer(db: State<'_, DbState>) -> Result<(), String> {
    with_db(db, move |db| db.discard_timer()).await
}

#[tauri::command]
async fn get_active_timer(db: State<'_, DbState>) -> Result<Option<ActiveTimer>, String> {
    with_db(db, move |db| db.get_active_timer()).await
}

#[tauri::command]
async fn time_totals(
    db: State<'_, DbState>, item_ids: Vec<String>,
) -> Result<std::collections::HashMap<String, i64>, String> {
    with_db(db, move |db| db.time_totals(&item_ids)).await
}

#[tauri::command]
async fn session_time_by_day(
    db: State<'_, DbState>, since: Option<String>, until: Option<String>,
) -> Result<Vec<DayTaskTime>, String> {
    with_db(db, move |db| db.session_time_by_day(since.as_deref(), until.as_deref())).await
}

// ---- Mobile sync commands -----------------------------------------------
// GitHub-file transport for the Android client: deploy exports tasks.json;
// pull fetches the phone's capture inbox for the frontend to ingest through
// the normal create path (token parsing); mark_ingested records the guard ids.
// See sync.rs for the invariants.

#[tauri::command]
async fn sync_get_config(db: State<'_, DbState>) -> Result<SyncConfig, String> {
    with_db(db, move |db| Ok(db.sync_config())).await
}

// The masthead owner: None = never asked (the first-run prompt shows),
// Some("") = asked and skipped ("Live @ DayApp"), Some(name) = named.
// Lives in the real db's meta so the mobile export can carry it.
#[tauri::command]
async fn get_owner_name(db: State<'_, DbState>) -> Result<Option<String>, String> {
    with_db(db, move |db| Ok(db.meta_get("owner_name")?)).await
}

#[tauri::command]
async fn set_owner_name(db: State<'_, DbState>, name: String) -> Result<(), String> {
    with_db(db, move |db| {
        let trimmed = name.trim();
        db.meta_set("owner_name", trimmed)?;
        log::info!("owner: masthead name {}", if trimmed.is_empty() { "cleared" } else { "set" });
        Ok(())
    })
    .await
}

#[tauri::command]
async fn sync_set_config(db: State<'_, DbState>, config: SyncConfig) -> Result<(), String> {
    with_db(db, move |db| db.sync_set_config(&config)).await
}

#[tauri::command]
async fn sync_deploy(db: State<'_, DbState>, force: bool) -> Result<String, String> {
    with_db(db, move |db| sync::deploy(&db, force).map(|o| o.describe())).await
}

#[tauri::command]
async fn sync_pull_captures(db: State<'_, DbState>) -> Result<Vec<Capture>, String> {
    with_db(db, move |db| sync::pull_captures(&db)).await
}

#[tauri::command]
async fn sync_mark_ingested(db: State<'_, DbState>, ids: Vec<String>) -> Result<(), String> {
    with_db(db, move |db| sync::mark_ingested(&db, &ids)).await
}

#[tauri::command]
async fn sync_status(db: State<'_, DbState>) -> Result<SyncStatus, String> {
    with_db(db, move |db| Ok(db.sync_status())).await
}

// ---- Backup commands -------------------------------------------------------
// Point-in-time snapshots of the real db (see backup.rs): ⌘P capture, reveal
// opens the backups folder in Finder. Capture-only — no restore surface.

#[tauri::command]
async fn capture_backup(db: State<'_, DbState>) -> Result<String, String> {
    with_db(db, move |db| {
        backup::capture(&db).map(|p| p.to_string_lossy().into_owned())
    })
    .await
}

#[tauri::command]
async fn reveal_backups(db: State<'_, DbState>) -> Result<(), String> {
    with_db(db, move |db| backup::reveal(&db.real_path)).await
}

// ---- CLI shell command -----------------------------------------------------
// ⌘P → CLI: Enable installs the `dayapp` command: a wrapper script in
// ~/.local/bin exec'ing the running binary (resolved via current_exe, so it
// tracks the real install rather than a hardcoded /Applications), plus the
// PATH line in ~/.zshrc when the file doesn't mention ~/.local/bin yet.
// Idempotent by content — re-running repairs a stale wrapper after an app
// move. Only the user's keystroke does this: an app that edits dotfiles
// unprompted is malware-shaped, so it's a door, not a launch side effect.

#[tauri::command]
async fn cli_install() -> Result<String, String> {
    use std::os::unix::fs::PermissionsExt;
    let home = std::env::var("HOME").map_err(|_| "no HOME set".to_string())?;
    let exe = std::env::current_exe()
        .map_err(|e| format!("resolve binary: {e}"))?
        .to_string_lossy()
        .to_string();

    let bin_dir = std::path::Path::new(&home).join(".local/bin");
    std::fs::create_dir_all(&bin_dir)
        .map_err(|e| format!("create {}: {e}", bin_dir.display()))?;
    let wrapper = bin_dir.join("dayapp");
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\n# dayapp — passthrough to the installed DayApp binary (⌘P → CLI: Enable).\n# Bare `dayapp` means `dayapp --list`; every other argument passes through.\nBIN=\"{exe}\"\n[ $# -eq 0 ] && set -- --list\nexec \"$BIN\" \"$@\"\n"
        ),
    )
    .map_err(|e| format!("write {}: {e}", wrapper.display()))?;
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("chmod {}: {e}", wrapper.display()))?;
    log::info!("cli: wrapper installed at {}", wrapper.display());

    // The GUI process can't see the user's interactive PATH (launchd gives it
    // a minimal one), so the check is over the rc file, not the env.
    let rc = std::path::Path::new(&home).join(".zshrc");
    let rc_text = std::fs::read_to_string(&rc).unwrap_or_default();
    let mut path_added = false;
    if !rc_text.contains(".local/bin") {
        let mut next = rc_text;
        if !next.is_empty() && !next.ends_with('\n') {
            next.push('\n');
        }
        next.push_str("\n# Added by DayApp — expose the dayapp CLI\nexport PATH=\"$HOME/.local/bin:$PATH\"\n");
        std::fs::write(&rc, &next).map_err(|e| format!("write {}: {e}", rc.display()))?;
        path_added = true;
        log::info!("cli: PATH line added to {}", rc.display());
    }

    Ok(if path_added {
        "CLI enabled — `dayapp` works in new terminal windows".to_string()
    } else {
        "CLI enabled — `dayapp` is on your PATH".to_string()
    })
}

// ---- Demo mode -----------------------------------------------------------
// A second, disposable db (dayapp-demo.db) swapped in under the connection
// lock — see demo.rs for the invariants. The "demo-mode" event tells the
// frontend to re-pull everything and swap the masthead; toggling never touches
// the real db's file beyond parking its (already open) connection.

#[tauri::command]
async fn demo_mode(db: State<'_, DbState>) -> Result<bool, String> {
    with_db(db, move |db| Ok(db.is_demo())).await
}

#[tauri::command]
async fn enter_demo_mode(app: AppHandle, db: State<'_, DbState>) -> Result<(), String> {
    toggle_demo(app, db, true).await
}

#[tauri::command]
async fn exit_demo_mode(app: AppHandle, db: State<'_, DbState>) -> Result<(), String> {
    toggle_demo(app, db, false).await
}

async fn toggle_demo(app: AppHandle, state: State<'_, DbState>, on: bool) -> Result<(), String> {
    let db = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || if on { db.enter_demo() } else { db.exit_demo() })
        .await
        .map_err(|e| format!("task join error: {e}"))?
        .map_err(|e| format!("{e:#}"))?;
    let _ = app.emit("demo-mode", serde_json::json!({ "active": on }));
    Ok(())
}

#[tauri::command]
async fn reset_demo_data(app: AppHandle, db: State<'_, DbState>) -> Result<(), String> {
    let db = db.0.clone();
    tauri::async_runtime::spawn_blocking(move || db.reset_demo())
        .await
        .map_err(|e| format!("task join error: {e}"))?
        .map_err(|e| format!("{e:#}"))?;
    // Same event as a toggle: the frontend re-pulls the re-seeded data.
    let _ = app.emit("demo-mode", serde_json::json!({ "active": true }));
    Ok(())
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

// ---- Release updates (GitHub Releases → in-app auto-update) ----------------
//
// The channel for people who installed the shipped .app and have no source
// checkout (the opposite of self_update above). The frontend polls
// `update_check` (launch + every few hours) and shows a header icon when a
// newer release exists; clicking it runs `update_install`, which downloads,
// verifies the release's minisign signature against the pubkey baked into
// tauri.conf.json, swaps the bundle, and relaunches. Artifacts are only built
// by scripts/release.sh (tauri.release.conf.json), so a plain source build
// never needs the signing key.
//
// Progress rides the same "update-status" channel the local build uses, with
// phase "downloading" instead of "building" — the overlay renders either.

/// True when the app was built from a source checkout that still exists at the
/// path embedded at compile time. Release binaries carry this machine's build
/// path, which doesn't exist on a user's Mac — that's the whole local/release
/// split the frontend branches on.
#[tauri::command]
async fn update_source_available() -> Result<bool, String> {
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("no parent")?;
    Ok(repo.join("package.json").exists())
}

/// The version a release update would install, or None when this install is
/// current (or the manifest is unreachable — offline, no release yet). A
/// failed check reads as "no update": the icon just doesn't appear, and the
/// next poll retries. Failures warn once per distinct message like the sync
/// loop, so an outage doesn't spam the log.
#[tauri::command]
async fn update_check(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app
        .updater()
        .map_err(|e| format!("{e:#}"))?
        .check()
        .await
        .map_err(|e| format!("{e:#}"))?;
    Ok(update.map(|u| {
        log::info!("update: release {} available", u.version);
        u.version
    }))
}

/// Download, signature-verify, and install the pending release update, then
/// relaunch. Progress streams as throttled "downloading" lines (one per 256
/// KB, plus the final total) so the overlay log stays readable.
#[tauri::command]
async fn update_install(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    log::info!("update: downloading release update");
    let update = app
        .updater()
        .map_err(|e| format!("{e:#}"))?
        .check()
        .await
        .map_err(|e| format!("{e:#}"))?
        .ok_or_else(|| "no update available".to_string())?;
    let handle = app.clone();
    let last_emit = std::cell::Cell::new(0u64);
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let final_ = total == Some(downloaded);
                // Throttle: emit at 256 KB steps and at completion.
                if final_ || downloaded.saturating_sub(last_emit.get()) >= 256 * 1024 {
                    last_emit.set(downloaded);
                    let so_far = format_bytes(downloaded);
                    let text = match total {
                        Some(t) => format!("Downloading {so_far} / {}", format_bytes(t)),
                        None => format!("Downloading {so_far}"),
                    };
                    let _ = handle.emit(
                        "update-status",
                        serde_json::json!({ "phase": "downloading", "data": text }),
                    );
                }
            },
            || log::info!("update: download complete, installing"),
        )
        .await
        .map_err(|e| {
            log::error!("update: release install failed: {e:#}");
            format!("{e:#}")
        })?;
    log::info!("update: release {} installed; relaunching", update.version);
    let _ = app.emit(
        "update-status",
        serde_json::json!({
            "phase": "restarting",
            "data": format!("Update {} installed — restarting DayApp…", update.version),
        }),
    );
    app.restart();
}

/// Byte count the way the overlay log wants it: "364 KB", "4.2 MB".
fn format_bytes(n: u64) -> String {
    if n >= 1024 * 1024 {
        format!("{:.1} MB", n as f64 / (1024.0 * 1024.0))
    } else if n >= 1024 {
        format!("{:.0} KB", n as f64 / 1024.0)
    } else {
        format!("{n} B")
    }
}

// ---- Setup ----------------------------------------------------------------

// The launch placement ritual, automated: DayApp always lands fullscreened in
// AeroSpace workspace 10 (the manual alt-shift-0 + alt-f sequence). The
// workspace move lives in ~/.aerospace.toml's on-window-detected — AeroSpace
// callbacks only support layout/move commands, so the fullscreen half lives
// here: find OUR window in AeroSpace's list (matched by pid + app name, so
// never another app's) and ask the CLI to fullscreen that window id,
// retrying briefly while AeroSpace is still attaching us. `on` is idempotent;
// wherever AeroSpace isn't installed the first command simply fails and this
// is a silent no-op (DayApp is public-source — not every machine tiles).
fn aerospace_fullscreen() {
    let pid = std::process::id().to_string();
    std::thread::spawn(move || {
        for delay_ms in [400u64, 1200, 2500, 5000] {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            let Ok(out) = std::process::Command::new("aerospace")
                .args(["list-windows", "--all", "--format", "%{window-id} %{app-pid} %{app-name}"])
                .output()
            else {
                return; // no aerospace binary — nothing to ask
            };
            let listing = String::from_utf8_lossy(&out.stdout);
            let our_window = listing.lines().find(|l| {
                let mut f = l.split_whitespace();
                f.next().is_some() && f.next() == Some(pid.as_str()) && f.next() == Some("DayApp")
            });
            let Some(wid) = our_window.and_then(|l| l.split_whitespace().next()) else {
                continue; // window not attached to the tree yet
            };
            let fullscreen = std::process::Command::new("aerospace")
                .args(["fullscreen", "--window-id", wid, "on"])
                .output()
                .is_ok_and(|o| o.status.success());
            if fullscreen {
                log::info!("placement: aerospace fullscreened window {wid}");
                return;
            }
        }
        log::debug!("placement: aerospace never attached the window; skipped fullscreen");
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            let first_run = !db_path.exists();
            let db = Db::open(&db_path)?;
            if first_run {
                log::info!("first run: clean db created — demo mode stays a ⌘P action");
            }
            // Launch sweeps: today → Backlog fall, done-today retirement,
            // expired-hide restore, reminder promotion. Idempotent.
            db.launch_sweeps()?;
            let db = Arc::new(db);
            // One-way export loop: push tasks.json once a minute when it
            // changed. A plain sleeping thread is enough (single user, one
            // cycle/min); it also picks up writes made by the CLI, since both
            // processes share the db file. Failures log once per distinct
            // message so a persistent outage doesn't spam the log.
            {
                let loop_db = db.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(15));
                    let mut last_err = String::new();
                    loop {
                        match sync::deploy(&loop_db, false) {
                            Ok(sync::DeployOutcome::Pushed(n)) => {
                                log::info!("sync: deployed tasks.json ({n} items)");
                                last_err.clear();
                            }
                            Ok(_) => last_err.clear(),
                            Err(e) => {
                                let msg = format!("{e:#}");
                                if msg != last_err {
                                    log::warn!("sync: deploy failed: {msg}");
                                    last_err = msg;
                                }
                            }
                        }
                        std::thread::sleep(std::time::Duration::from_secs(60));
                    }
                });
            }
            app.manage(DbState(db));
            // AeroSpace placement (see aerospace_fullscreen): the workspace-10
            // half is ~/.aerospace.toml's on-window-detected; this asks for the
            // fullscreen half once AeroSpace has attached the window.
            aerospace_fullscreen();
            log::info!("DayApp ready");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_items, create_item, edit_item, complete_item, uncomplete_item,
            move_item, delete_item, run_sweep,
            hide_item, unhide_item,
            list_actions, journal_dashboard, journal_day_detail,
            list_notes, create_note, update_note, set_note_priority, set_note_project, delete_note,
            hide_note, unhide_note, save_text_file, devlog_append,
            list_entries, add_entry, update_entry, delete_entry,
            list_projects, create_project, rename_project, delete_project, set_item_project,
            set_reminder, set_item_priority, set_item_agent, set_item_details,
            list_goals, create_goal, edit_goal, set_goal_project,
            achieve_goal, unachieve_goal, delete_goal,
            start_timer, stop_timer, discard_timer, get_active_timer,
            time_totals, session_time_by_day,
            sync_get_config, sync_set_config, sync_deploy,
            sync_pull_captures, sync_mark_ingested, sync_status,
            capture_backup, reveal_backups,
            demo_mode, enter_demo_mode, exit_demo_mode, reset_demo_data,
            self_update,
            update_source_available, update_check, update_install,
            get_owner_name, set_owner_name,
            cli_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DayApp");
}

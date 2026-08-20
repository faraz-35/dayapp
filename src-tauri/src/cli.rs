// Headless CLI — remote access to DayApp over SSH/zcode.
//
//   dayapp --list [today|daily|backlog]     print tasks (timer/done/🤖 agent markers)
//   dayapp --add "text" [--to backlog]      create (today|daily|backlog; default backlog)
//   dayapp --complete "query"               complete (stops its timer first)
//   dayapp --start "query"                  start the single active timer
//   dayapp --goals                          print goals grouped by horizon
//   dayapp --deploy                         force-push tasks.json now (read-only)
//   dayapp --sync-pull-peek                 print the phone's pending captures
//
// A `query` is an item id prefix or a unique case-insensitive substring of the
// text; Today rows win ties. Runs against the same db the GUI holds (WAL +
// busy_timeout make the two processes safe together), and after a write it
// fires one best-effort deploy so the phone sees the change within seconds.
//
// Note: --add writes raw text (no `#tag`/`!N` parsing — that lives in the
// frontend). Tokens typed here stay literal until edited in the GUI.

use crate::db::{Db, HiddenFilter, Item};
use crate::goals::{Goal, HORIZONS};
use crate::sync::{self, DeployOutcome};

pub fn run(args: Vec<String>) -> i32 {
    let Some(db) = open_db() else { return 1 };
    let mut it = args.into_iter();
    let Some(cmd) = it.next() else { return usage() };
    let rest: Vec<String> = it.collect();
    let result = match cmd.as_str() {
        "--list" => list(&db, rest.first().map(|s| s.as_str())),
        "--add" => add(&db, &rest),
        "--complete" => with_query(&db, &rest, |db, item| {
            // Same rule as the GUI: completing a running item stops its timer
            // first (the session is kept).
            if let Ok(Some(t)) = db.get_active_timer() {
                if t.item_id == item.id {
                    db.stop_timer()?;
                }
            }
            db.complete_item(&item.id)
        }),
        "--start" => with_query(&db, &rest, |db, item| {
            db.start_timer(&item.id).map(|_| ())
        }),
        "--goals" => goals(&db),
        "--deploy" => sync::deploy(&db, true).map(|o| println!("{}", o.describe())),
        "--sync-pull-peek" => peek(&db),
        "--help" | "-h" => {
            println!("usage: dayapp --list [today|daily|backlog] | --add \"text\" [--to backlog] | --complete <query> | --start <query> | --goals | --deploy | --sync-pull-peek");
            Ok(())
        }
        _ => Err(anyhow::anyhow!("unknown command \"{cmd}\" — try --help")),
    };
    match result {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("dayapp: {e:#}");
            1
        }
    }
}

fn usage() -> i32 {
    eprintln!("usage: dayapp --list [section] | --add \"text\" [--to backlog] | --complete <query> | --start <query> | --goals | --deploy | --sync-pull-peek");
    1
}

/// Print goals grouped by horizon, the way the GUI shows them (timeless →
/// long → short, achieved last). Read-only — this is the agent-context view of
/// the identity layer.
fn goals(db: &Db) -> anyhow::Result<()> {
    let all = db.list_goals()?;
    if all.is_empty() {
        println!("no goals");
        return Ok(());
    }
    let active = |h: &str| {
        all.iter()
            .filter(|g| g.horizon == h && g.status == "active")
            .collect::<Vec<&Goal>>()
    };
    for horizon in HORIZONS {
        let group = active(horizon);
        if group.is_empty() { continue; }
        println!("{horizon}:");
        for g in group {
            println!("  {}", g.text);
        }
    }
    let done: Vec<&Goal> = all.iter().filter(|g| g.status == "achieved").collect();
    if !done.is_empty() {
        println!("achieved:");
        for g in done {
            // now_iso timestamps are local RFC3339; the date prefix is enough
            // for a goal's achievement record.
            let day = g.achieved_at.as_deref().and_then(|a| a.split('T').next()).unwrap_or("");
            let when = if day.is_empty() { String::new() } else { format!(" ({day})") };
            println!("  ✓ {}{when}", g.text);
        }
    }
    Ok(())
}

/// Print the phone's pending captures without ingesting them — a read-only
/// peek at the inbox for remote checks.
fn peek(db: &Db) -> anyhow::Result<()> {
    let caps = sync::pull_captures(db)?;
    if caps.is_empty() {
        println!("inbox empty");
    }
    for c in caps {
        println!("[{}] {}", c.section, c.text);
    }
    Ok(())
}

/// Open the shared db. Tauri's app_data_dir is ~/Library/Application Support/
/// <identifier>; older installs may have used the product name, so accept both.
fn open_db() -> Option<Db> {
    let home = std::env::var_os("HOME")?;
    let base = std::path::PathBuf::from(home).join("Library/Application Support");
    let candidates = [
        base.join("com.farazshah.dayapp").join("dayapp.db"),
        base.join("DayApp").join("dayapp.db"),
    ];
    let path = candidates
        .iter()
        .find(|p| p.exists())
        .cloned()
        .unwrap_or_else(|| candidates[0].clone());
    match Db::open(&path) {
        Ok(db) => Some(db),
        Err(e) => {
            eprintln!("dayapp: cannot open {}: {e:#}", path.display());
            None
        }
    }
}

fn all_items(db: &Db) -> anyhow::Result<Vec<(Item, &'static str)>> {
    let today = db.list("today", true, HiddenFilter::Exclude)?;
    let daily = db.list("daily", false, HiddenFilter::Exclude)?;
    let backlog = db.list("backlog", false, HiddenFilter::Exclude)?;
    Ok(today.into_iter().map(|i| (i, "today")).chain(
        daily.into_iter().map(|i| (i, "daily"))).chain(
        backlog.into_iter().map(|i| (i, "backlog"))).collect())
}

fn list(db: &Db, section: Option<&str>) -> anyhow::Result<()> {
    if let Some(s) = section {
        if !["today", "daily", "backlog"].contains(&s) {
            anyhow::bail!("unknown section \"{s}\" (today | daily | backlog)");
        }
    }
    let timer = db.get_active_timer().ok().flatten();
    let today = crate::db::today_iso();
    for (item, sec) in all_items(db)? {
        if let Some(s) = section {
            if sec != s { continue; }
        }
        let done = match sec {
            "daily" => item.last_completed_date.as_deref() == Some(today.as_str()),
            _ => item.status == "done",
        };
        let timing = timer.as_ref().map(|t| t.item_id == item.id).unwrap_or(false);
        let mark = if timing { "▶" } else if done { "✓" } else { " " };
        let prio = item.priority.map(|p| format!(" !{p}")).unwrap_or_default();
        // The delegation axis: 🤖 marks rows assigned to the AI agent, so an
        // agent (or Faraz over SSH) can see which tasks are theirs to take.
        let agent = if item.assigned_to_agent { "🤖 " } else { "" };
        println!("{mark} {sec:<8} {prio}{agent}{}", item.text);
    }
    Ok(())
}

fn add(db: &Db, rest: &[String]) -> anyhow::Result<()> {
    let mut text: Option<String> = None;
    let mut section = "backlog".to_string();
    let mut it = rest.iter();
    while let Some(a) = it.next() {
        if a == "--to" {
            section = it.next().ok_or_else(|| anyhow::anyhow!("--to needs a section (today | daily | backlog)"))?.clone();
            if !["today", "daily", "backlog"].contains(&section.as_str()) {
                anyhow::bail!("unknown section \"{section}\"");
            }
        } else {
            text = Some(a.clone());
        }
    }
    let text = text.ok_or_else(|| anyhow::anyhow!("--add needs quoted text"))?;
    if text.trim().is_empty() {
        anyhow::bail!("empty text");
    }
    let item = db.create_item(text.trim(), &section)?;
    println!("added to {section}: {}", item.text);
    deploy_hint(db);
    Ok(())
}

fn with_query<F>(db: &Db, rest: &[String], f: F) -> anyhow::Result<()>
where F: FnOnce(&Db, &Item) -> anyhow::Result<()>,
{
    let q = rest.first().ok_or_else(|| anyhow::anyhow!("needs a <query> (id prefix or unique text substring)"))?;
    let item = find_item(db, q)?;
    f(db, &item)?;
    deploy_hint(db);
    Ok(())
}

/// Match by item id prefix first, else a unique case-insensitive text
/// substring. Today-section rows are searched first so bare text that exists
/// in two sections resolves to the actionable one.
fn find_item(db: &Db, q: &str) -> anyhow::Result<Item> {
    let all = all_items(db)?;
    if let Some((item, _)) = all.iter().find(|(i, _)| i.id.starts_with(q)) {
        return Ok(item.clone());
    }
    let lower = q.to_lowercase();
    let hits: Vec<&Item> = all.iter().filter(|(i, _)| i.text.to_lowercase().contains(&lower)).map(|(i, _)| i).collect();
    match hits.len() {
        0 => anyhow::bail!("no task matches \"{q}\""),
        1 => Ok(hits[0].clone()),
        _ => {
            let names: Vec<String> = hits.iter().map(|i| format!("  {}", i.text)).collect();
            anyhow::bail!("\"{q}\" matches {} tasks:\n{}", hits.len(), names.join("\n"))
        }
    }
}

/// One best-effort deploy after a write, so a remote trigger reaches the phone
/// immediately instead of waiting for the GUI's next 60s pass.
fn deploy_hint(db: &Db) {
    if let Ok(DeployOutcome::Pushed(n)) = sync::deploy(db, false) {
        println!("sync: pushed {n} items to the phone mirror");
    }
}

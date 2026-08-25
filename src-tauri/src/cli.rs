// Headless CLI — remote access to DayApp over SSH/zcode.
//
//   dayapp --list [today|daily|backlog] [--hidden]   print tasks (▶/✓/◐ marks, !prio, 🤖 agent, #project)
//   dayapp --task <query>                   print one task in full, incl. its details
//   dayapp --search <query>                 ⌘F, headless: text substring, #project, @agent/@my
//   dayapp --journal [range]                the journal: dashboard summary +
//                                           actions + per-task time by day
//                                           (today | week | month | all | YYYY-MM-DD; default today)
//   dayapp --notes [query] [--hidden]       print notes (optional body-substring filter)
//   dayapp --projects                       list projects as #tags
//   dayapp --add "text" [--to backlog]      create (today|daily|backlog; default backlog)
//   dayapp --complete "query"               complete (stops its timer first)
//   dayapp --start "query"                  start the single active timer
//   dayapp --move "query" --to today        move between sections (appends; logs moved)
//   dayapp --details "query" "body"         replace the details body ("" clears; not logged)
//   dayapp --goals                          print goals grouped by horizon
//   dayapp --deploy                         force-push tasks.json now (read-only)
//   dayapp --sync-pull-peek                 print the phone's pending captures
//   dayapp --demo <any of the above>        run against the demo db instead
//
// The read flags mirror the GUI's surfaces so a remote session can reach any
// information the app can show: --search is ⌘F, --journal is the journal
// view, --notes/--projects are their sections, and --hidden is the ⌘P
// "Show Hidden" reveal. What the GUI renders as panels, the CLI renders as
// text — same data, same verbs.
//
// A `query` is an item id prefix or a unique case-insensitive substring of the
// text; Today rows win ties. Runs against the same db the GUI holds (WAL +
// busy_timeout make the two processes safe together), and after a write it
// fires one best-effort deploy so the phone sees the change within seconds.
// `--demo` (anywhere in the args) opens dayapp-demo.db instead — the seeded
// sample dataset from ⌘P → Enter Demo Mode, created on first use; writes land
// in the demo db only, and the deploy hint stays silent (demo data never
// reaches the phone).
//
// Note: --add writes raw text (no `#tag`/`!N` parsing — that lives in the
// frontend). Tokens typed here stay literal until edited in the GUI.

use crate::db::{Db, HiddenFilter, Item};
use crate::demo;
use crate::goals::{Goal, HORIZONS};
use crate::sync::{self, DeployOutcome};

pub fn run(args: Vec<String>) -> i32 {
    // `--demo` is a global modifier, not a command — filter it out before
    // dispatch and let open_db pick the file.
    let demo_mode = args.iter().any(|a| a == "--demo");
    let args: Vec<String> = args.into_iter().filter(|a| a != "--demo").collect();
    let Some(db) = open_db(demo_mode) else { return 1 };
    let mut it = args.into_iter();
    let Some(cmd) = it.next() else { return usage() };
    let rest: Vec<String> = it.collect();
    let result = match cmd.as_str() {
        "--list" => list(&db, &rest),
        "--task" => task(&db, &rest),
        "--add" => add(&db, &rest),
        "--complete" => with_query(&db, &rest, |db, item| {
            // complete_item finalizes the item's open session in the same
            // transaction (kept in history) — the stop-on-complete rule is
            // enforced backend-side, same as the GUI path.
            db.complete_item(&item.id)
        }),
        "--start" => with_query(&db, &rest, |db, item| {
            db.start_timer(&item.id).map(|_| ())
        }),
        "--move" => move_item(&db, &rest),
        "--details" => details(&db, &rest),
        "--search" => search(&db, &rest),
        "--journal" => journal(&db, rest.first().map(|s| s.as_str())),
        "--notes" => notes(&db, &rest),
        "--projects" => projects(&db),
        "--goals" => goals(&db),
        "--deploy" => sync::deploy(&db, true).map(|o| println!("{}", o.describe())),
        "--sync-pull-peek" => peek(&db),
        "--help" | "-h" => {
            println!("{USAGE}");
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

const USAGE: &str = "\
usage: dayapp [--demo] <command> [args]
  --list [section] [--hidden]    tasks (▶/✓ marks, !prio, 🤖 agent, #project)
  --task <query>                 one task in full, incl. its details
  --search <query>               ⌘F: text substring, #project, or @agent/@my
  --journal [range]              the journal: dashboard summary + time by day
                                 (today | week | month | all | YYYY-MM-DD)
  --notes [query] [--hidden]     notes, optionally filtered by body substring
  --projects                     projects as #tags
  --goals                        goals grouped by horizon
  --add \"text\" [--to section]   create (today|daily|backlog; default backlog)
  --complete <query>             complete (stops its timer first)
  --start <query>                start the single active timer
  --move <query> --to <section>  move a task (appends at the destination)
  --details <query> <body>       replace a task's details body (\"\" clears)
  --deploy                       force-push tasks.json now
  --sync-pull-peek               print the phone's pending captures
  --demo                         run against the demo db (global modifier)";

fn usage() -> i32 {
    eprintln!("{USAGE}");
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

/// ⌘F, headless: the same query semantics as the GUI's search modal. A plain
/// query is a case-insensitive substring over item text. A leading `#` flips
/// to the project axis — bare `#` lists the projects (the picker with nothing
/// typed), `#name` lists that project's rows. A leading `@` flips to the
/// delegation axis: `@agent` is the 🤖 queue, `@my` Faraz's own rows.
fn search(db: &Db, rest: &[String]) -> anyhow::Result<()> {
    let q = rest.first().ok_or_else(|| anyhow::anyhow!("--search needs a <query> (text substring, #project, or @agent/@my)"))?;
    let trimmed = q.trim_start();
    if let Some(name) = trimmed.strip_prefix('#') {
        return search_project(db, name.trim());
    }
    if let Some(mode) = trimmed.strip_prefix('@') {
        return search_agent(db, mode.trim());
    }
    let lower = q.to_lowercase();
    let rows: Vec<(Item, &'static str)> = all_items(db, HiddenFilter::Exclude)?
        .into_iter()
        .filter(|(i, _)| i.text.to_lowercase().contains(&lower))
        .collect();
    if rows.is_empty() {
        println!("no matches");
        return Ok(());
    }
    print_rows(db, &rows)
}

/// The `#` half of --search: project picker or project-filtered rows.
fn search_project(db: &Db, name: &str) -> anyhow::Result<()> {
    let projects = db.list_projects()?;
    if name.is_empty() {
        if projects.is_empty() {
            println!("no projects");
        }
        for p in &projects {
            println!("#{}", p.name);
        }
        return Ok(());
    }
    let lower = name.to_lowercase();
    let hits: Vec<_> = projects.iter().filter(|p| p.name.to_lowercase().contains(&lower)).collect();
    match hits.len() {
        0 => anyhow::bail!("no project matches \"{name}\""),
        1 => {
            let id = hits[0].id.as_str();
            let rows: Vec<(Item, &'static str)> = all_items(db, HiddenFilter::Exclude)?
                .into_iter()
                .filter(|(i, _)| i.project_id.as_deref() == Some(id))
                .collect();
            if rows.is_empty() {
                println!("no tasks in #{}", hits[0].name);
                return Ok(());
            }
            print_rows(db, &rows)
        }
        _ => {
            // Several candidates: print the names the picker would and let
            // the caller narrow with a longer `#name`.
            let names: Vec<String> = hits.iter().map(|p| format!("  #{}", p.name)).collect();
            anyhow::bail!("\"{name}\" matches {} projects:\n{}", hits.len(), names.join("\n"))
        }
    }
}

/// The `@` half of --search: the delegation picker's two fixed entries.
fn search_agent(db: &Db, mode: &str) -> anyhow::Result<()> {
    let agent = match mode {
        "" | "agent" => true,
        "my" | "mine" => false,
        other => anyhow::bail!("unknown picker \"{other}\" (@agent or @my)"),
    };
    let rows: Vec<(Item, &'static str)> = all_items(db, HiddenFilter::Exclude)?
        .into_iter()
        .filter(|(i, _)| i.assigned_to_agent == agent)
        .collect();
    if rows.is_empty() {
        println!("{}", if agent { "no agent tasks" } else { "no tasks of your own" });
        return Ok(());
    }
    print_rows(db, &rows)
}

/// The Journal view as text: the dashboard summary (done/missed totals,
/// project + priority splits — the same numbers the GUI renders above the
/// log), then actions grouped by day (newest day first, newest action first —
/// the GUI's render order) with the per-task time breakdown and day total
/// layered in. Each day header carries its done/missed. The range mirrors the
/// GUI's pills (default Today); a YYYY-MM-DD is the date jump. Time is a
/// separate dimension from the action filter pills, so both always print.
fn journal(db: &Db, range: Option<&str>) -> anyhow::Result<()> {
    use chrono::{Duration, Local, NaiveDate};
    use std::collections::BTreeSet;
    let today = Local::now().date_naive();
    let tomorrow = today + Duration::days(1);
    let (since, until): (Option<NaiveDate>, Option<NaiveDate>) = match range {
        None | Some("today") => (Some(today), Some(tomorrow)),
        Some("week") => (Some(today - Duration::days(6)), Some(tomorrow)),
        Some("month") => (Some(today - Duration::days(29)), Some(tomorrow)),
        Some("all") => (None, None),
        Some(day) => {
            let d = NaiveDate::parse_from_str(day, "%Y-%m-%d")
                .map_err(|_| anyhow::anyhow!("unknown range \"{day}\" (today | week | month | all | YYYY-MM-DD)"))?;
            (Some(d), Some(d + Duration::days(1)))
        }
    };
    let iso = |d: Option<NaiveDate>| d.map(|x| x.format("%Y-%m-%d").to_string());
    let dash =
        db.journal_dashboard(iso(since).as_deref(), iso(until).as_deref(), &Default::default())?;
    println!(
        "done {} · daily missed {} · today missed {}",
        dash.totals.done, dash.totals.daily_missed, dash.totals.today_missed
    );
    if !dash.projects.is_empty() {
        let parts: Vec<String> = dash
            .projects
            .iter()
            .map(|p| match &p.name {
                Some(n) => format!("#{n} {}", p.count),
                None => format!("none {}", p.count),
            })
            .collect();
        println!("projects: {}", parts.join(" · "));
    }
    let tiers: Vec<String> = dash
        .priorities
        .iter()
        .map(|t| match t.tier {
            Some(n) => format!("!{n} {}", t.count),
            None => format!("— {}", t.count),
        })
        .collect();
    println!("priority: {}", tiers.join(" · "));
    println!();

    let actions = db.list_actions(None, iso(since).as_deref(), iso(until).as_deref())?;
    let times = db.session_time_by_day(iso(since).as_deref(), iso(until).as_deref())?;

    // The set of days is the union of action days and time days — a day with
    // only tracked time still shows up (same rule as JournalView).
    let mut day_set: BTreeSet<String> = BTreeSet::new();
    for a in &actions {
        day_set.insert(a.timestamp[..10].to_string());
    }
    for t in &times {
        day_set.insert(t.day.clone());
    }
    if day_set.is_empty() {
        println!("no activity");
        return Ok(());
    }
    for day in day_set.iter().rev() {
        let mut day_times: Vec<_> = times.iter().filter(|t| t.day == *day).collect();
        day_times.sort_by_key(|t| std::cmp::Reverse(t.seconds)); // longest first
        let total: i64 = day_times.iter().map(|t| t.seconds).sum();
        let mut header = day.clone();
        if let Some(d) = dash.days.iter().find(|d| d.date == *day) {
            if d.done > 0 {
                header += &format!(" · {} done", d.done);
            }
            let missed = d.daily_missed + d.today_missed;
            if missed > 0 {
                header += &format!(" · {missed} missed");
            }
        }
        if total > 0 {
            header += &format!(" · {}", fmt_duration(total));
        }
        println!("{header}");
        for t in day_times {
            println!("  ⏱ {} · {}", t.item_text, fmt_duration(t.seconds));
        }
        for a in actions.iter().filter(|a| a.timestamp.starts_with(day.as_str())) {
            println!("  {}  {:<15} {}", &a.timestamp[11..16], verb(&a.action), a.item_text);
        }
    }
    Ok(())
}

/// The journal's verb phrasing — the same words JournalView renders.
fn verb(action: &str) -> &str {
    match action {
        "created" => "added",
        "completed" => "completed",
        "uncompleted" => "unchecked",
        "moved" => "moved",
        "edited" => "edited",
        "deleted" => "deleted",
        "fell_to_backlog" => "fell to backlog",
        "goal_created" => "set goal",
        "goal_achieved" => "achieved goal",
        "goal_unachieved" => "reopened goal",
        "goal_edited" => "edited goal",
        "goal_deleted" => "dropped goal",
        other => other,
    }
}

/// The GUI's formatDuration (lib.ts): `1h 20m`, `45m`, `30s`.
fn fmt_duration(secs: i64) -> String {
    let s = secs.max(0);
    let (h, m) = (s / 3600, (s % 3600) / 60);
    if h > 0 { format!("{h}h {m}m") }
    else if m > 0 { format!("{m}m") }
    else { format!("{s}s") }
}

/// An ISO date as the reminder chip renders it (Aug 25); raw on parse failure.
fn pretty_date(iso: &str) -> String {
    use chrono::Datelike;
    chrono::NaiveDate::parse_from_str(iso, "%Y-%m-%d")
        .map(|d| format!("{} {}", d.format("%b"), d.day()))
        .unwrap_or_else(|_| iso.to_string())
}

/// The notes surface as text: full bodies in tier order, blocks separated by a
/// blank line. A note's priority/project (set via the token grammar, consumed
/// into columns — never stored in the body) rides as a reconstructed token
/// line after the body, where the footer used to read, so a remote session
/// still sees the axes in the text. An optional query filters by substring
/// (body + that line, ⌘F-style); `--hidden` includes archived notes, each
/// introduced by a ◐ line.
fn notes(db: &Db, rest: &[String]) -> anyhow::Result<()> {
    let (query, hidden) = split_query_flag(rest)?;
    let filter = if hidden { HiddenFilter::Include } else { HiddenFilter::Exclude };
    let all = db.list_notes(filter)?;
    let projects = project_names(db)?;
    let meta_line = |n: &crate::notes::Note| {
        let mut parts: Vec<String> = Vec::new();
        if let Some(p) = n.priority { parts.push(format!("!{p}")); }
        if let Some(name) = n.project_id.as_ref().and_then(|pid| projects.get(pid)) {
            parts.push(format!("#{name}"));
        }
        parts.join(" ")
    };
    let selected: Vec<_> = match &query {
        Some(q) => {
            let lower = q.to_lowercase();
            all.into_iter()
                .filter(|n| format!("{}\n{}", n.body, meta_line(n)).to_lowercase().contains(&lower))
                .collect()
        }
        None => all,
    };
    if selected.is_empty() {
        println!("{}", if query.is_some() { "no notes match" } else { "no notes" });
        return Ok(());
    }
    for (i, n) in selected.iter().enumerate() {
        if i > 0 {
            println!();
        }
        if n.hidden {
            println!("◐");
        }
        if n.body.trim().is_empty() {
            println!("(empty)");
        } else {
            for line in n.body.lines() {
                println!("{line}");
            }
        }
        let meta = meta_line(n);
        if !meta.is_empty() {
            println!();
            println!("{meta}");
        }
    }
    Ok(())
}

/// Projects as #tags — the same spelling --search `#name` and the capture
/// field's `#tag` use, so picking a filter from here is copy-pasteable.
fn projects(db: &Db) -> anyhow::Result<()> {
    let all = db.list_projects()?;
    if all.is_empty() {
        println!("no projects");
        return Ok(());
    }
    for p in all {
        println!("#{}", p.name);
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
/// With `demo`, opens the sibling demo db instead (created + seeded on first
/// use — the same dataset as ⌘P → Enter Demo Mode).
fn open_db(demo_mode: bool) -> Option<Db> {
    let home = std::env::var_os("HOME")?;
    let base = std::path::PathBuf::from(home).join("Library/Application Support");
    let candidates = [
        base.join("com.farazshah.dayapp").join("dayapp.db"),
        base.join("DayApp").join("dayapp.db"),
    ];
    let real = candidates
        .iter()
        .find(|p| p.exists())
        .cloned()
        .unwrap_or_else(|| candidates[0].clone());
    let (path, result) = if demo_mode {
        let p = demo::demo_db_path(&real);
        (p.clone(), Db::open_demo(&real))
    } else {
        (real.clone(), Db::open(&real))
    };
    match result {
        Ok(db) => Some(db),
        Err(e) => {
            eprintln!("dayapp: cannot open {}: {e:#}", path.display());
            None
        }
    }
}

fn all_items(db: &Db, hidden: HiddenFilter) -> anyhow::Result<Vec<(Item, &'static str)>> {
    let today = db.list("today", true, hidden)?;
    let daily = db.list("daily", false, hidden)?;
    let backlog = db.list("backlog", false, hidden)?;
    Ok(today.into_iter().map(|i| (i, "today")).chain(
        daily.into_iter().map(|i| (i, "daily"))).chain(
        backlog.into_iter().map(|i| (i, "backlog"))).collect())
}

/// Split a command's args into its optional positional query and whether
/// `--hidden` was passed (any order) — the shared shape of --list/--notes.
fn split_query_flag(rest: &[String]) -> anyhow::Result<(Option<String>, bool)> {
    let mut query: Option<String> = None;
    let mut hidden = false;
    for a in rest {
        if a == "--hidden" {
            hidden = true;
        } else if query.is_none() {
            query = Some(a.clone());
        } else {
            anyhow::bail!("unexpected argument \"{a}\"");
        }
    }
    Ok((query, hidden))
}

fn list(db: &Db, rest: &[String]) -> anyhow::Result<()> {
    let (section, hidden) = split_query_flag(rest)?;
    if let Some(s) = &section {
        if !["today", "daily", "backlog"].contains(&s.as_str()) {
            anyhow::bail!("unknown section \"{s}\" (today | daily | backlog)");
        }
    }
    let filter = if hidden { HiddenFilter::Include } else { HiddenFilter::Exclude };
    let rows: Vec<(Item, &'static str)> = all_items(db, filter)?
        .into_iter()
        .filter(|(_, sec)| section.as_deref().map_or(true, |s| s == *sec))
        .collect();
    print_rows(db, &rows)
}

/// Print rows in the shared --list/--search format. The mark column is the
/// single running timer (▶), done (✓), or hidden (◐) — hidden rows aren't
/// actionable, so ◐ stands in for their state.
fn print_rows(db: &Db, rows: &[(Item, &'static str)]) -> anyhow::Result<()> {
    let timer = db.get_active_timer().ok().flatten();
    // Project names for the trailing #tag — the goal↔task correlation axis:
    // a goal linked to project X spawns tasks tagged #X, and the agent
    // reading --list can tie rows back to the goal that motivated them.
    let projects = project_names(db)?;
    let today = crate::db::today_iso();
    for (item, sec) in rows {
        let done = match *sec {
            "daily" => item.last_completed_date.as_deref() == Some(today.as_str()),
            _ => item.status == "done",
        };
        let timing = timer.as_ref().map(|t| t.item_id == item.id).unwrap_or(false);
        let mark = if item.hidden { "◐" }
            else if timing { "▶" }
            else if done { "✓" }
            else { " " };
        println!("{mark} {sec:<8} {}", row_meta(item, &projects));
    }
    Ok(())
}

/// The row's text with its metadata: !priority, 🤖 agent mark, #project — the
/// one formatting shared by --list, --search, and --task.
fn row_meta(item: &Item, projects: &std::collections::HashMap<String, String>) -> String {
    let prio = item.priority.map(|p| format!(" !{p}")).unwrap_or_default();
    // The delegation axis: 🤖 marks rows assigned to the AI agent, so an
    // agent (or Faraz over SSH) can see which tasks are theirs to take.
    let agent = if item.assigned_to_agent { "🤖 " } else { "" };
    let proj = item
        .project_id
        .as_ref()
        .and_then(|id| projects.get(id).map(|n| format!(" #{n}")))
        .unwrap_or_default();
    format!("{prio}{agent}{}{proj}", item.text)
}

/// id → name map for the trailing #tags shared by --list and --task.
fn project_names(db: &Db) -> anyhow::Result<std::collections::HashMap<String, String>> {
    Ok(db.list_projects()?.into_iter().map(|p| (p.id, p.name)).collect())
}

/// Print one task in full — the --list row (minus the done/timer mark) plus
/// its cumulative time and pending reminder, then the details body,
/// indented. This is the prompt surface for agent-delegated rows: an
/// automation (or any session) picks a 🤖 task from --list and reads the
/// spec here before working it.
fn task(db: &Db, rest: &[String]) -> anyhow::Result<()> {
    let q = rest.first().ok_or_else(|| anyhow::anyhow!("--task needs a <query> (id prefix or unique text substring)"))?;
    let item = find_item(db, q)?;
    let sec = item.section.as_str();
    println!("{sec:<8} {}", row_meta(&item, &project_names(db)?));
    if let Ok(totals) = db.time_totals(&[item.id.clone()]) {
        if let Some(secs) = totals.get(&item.id) {
            if *secs > 0 {
                println!("  ⏱ {}", fmt_duration(*secs));
            }
        }
    }
    if let Some(r) = item.remind_at.as_deref() {
        println!("  remind {}", pretty_date(r));
    }
    if item.details.trim().is_empty() {
        println!("no details");
    } else {
        for line in item.details.lines() {
            println!("  {line}");
        }
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

/// Move a task between sections — the drag, headless. There's no meaningful
/// drop index over SSH, so the row appends to the end of the destination
/// (move_item clamps the index). A same-section move is a no-op: the CLI has
/// no use for reorder-by-append.
fn move_item(db: &Db, rest: &[String]) -> anyhow::Result<()> {
    let mut query: Option<String> = None;
    let mut to: Option<String> = None;
    let mut it = rest.iter();
    while let Some(a) = it.next() {
        if a == "--to" {
            to = Some(it.next().ok_or_else(|| anyhow::anyhow!("--to needs a section (today | daily | backlog)"))?.clone());
        } else if query.is_none() {
            query = Some(a.clone());
        } else {
            anyhow::bail!("unexpected argument \"{a}\"");
        }
    }
    let q = query.ok_or_else(|| anyhow::anyhow!("--move needs a <query> (id prefix or unique text substring) and --to <section>"))?;
    let to = to.ok_or_else(|| anyhow::anyhow!("--move needs --to <section> (today | daily | backlog)"))?;
    if !["today", "daily", "backlog"].contains(&to.as_str()) {
        anyhow::bail!("unknown section \"{to}\"");
    }
    let item = find_item(db, &q)?;
    if item.section == to {
        println!("already in {to}: {}", item.text);
        return Ok(());
    }
    db.move_item(&item.id, &to, i64::MAX)?;
    println!("moved to {to}: {}", item.text);
    deploy_hint(db);
    Ok(())
}

/// Replace a task's details body — the spec/prompt under the title. The whole
/// body is replaced (the GUI textarea IS the content; no append mode) and ""
/// clears it. Like the GUI's edits this is housekeeping: not logged. Words
/// after the query join with spaces, so quoting is optional for one-liners.
fn details(db: &Db, rest: &[String]) -> anyhow::Result<()> {
    if rest.len() < 2 {
        anyhow::bail!("--details needs a <query> and a <body> (quoted; \"\" clears)");
    }
    let item = find_item(db, &rest[0])?;
    let body = rest[1..].join(" ");
    db.set_item_details(&item.id, &body)?;
    println!("details updated: {}", item.text);
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
/// in two sections resolves to the actionable one. Hidden rows stay
/// unreachable — the same rows the GUI's actionable list excludes.
fn find_item(db: &Db, q: &str) -> anyhow::Result<Item> {
    let all = all_items(db, HiddenFilter::Exclude)?;
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

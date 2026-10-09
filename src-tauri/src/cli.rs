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
//   dayapp --backup                         snapshot the db into backups/ (prints the path)
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
use crate::settings;
use std::path::PathBuf;
use rusqlite::{params, OptionalExtension};
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
            if store().ok().and_then(|m| m.get("dayapp-timer-enabled").cloned()) == Some("0".into()) {
                return Err(anyhow::anyhow!("the timer is off in settings"));
            }
            db.start_timer(&item.id).map(|_| ())
        }),
        "--move" => move_item(&db, &rest),
        "--details" => details(&db, &rest),
        "--search" => search(&db, &rest),
        "--journal" => journal_entries(&db, rest.first().map(|s| s.as_str())),
        "--analytics" => analytics(&db, &rest),
        "--notes" => notes(&db, &rest),
        "--projects" => projects(&db),
        "--goals" => goals(&db),
        "--backup" => backup_cmd(&db),
        "--deploy" => sync::deploy(&db, true).map(|o| println!("{}", o.describe())),
        "--sync-pull-peek" => peek(&db),
        "--settings" => settings_cmd(&rest),
        "--themes" => themes_cmd(),
        "--theme-create" => theme_create(&rest),
        "--theme" => theme_activate(&rest),
        "--views" => views_cmd(),
        "--view-create" => view_create(&db, &rest),
        "--view-enter" => view_set_active(&rest, true),
        "--view-exit" => view_set_active(&rest, false),
        "--view-delete" => view_delete(&rest),
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
  --backup                       snapshot the db into backups/ (prints the path)
  --add \"text\" [--to section]   create (today|daily|backlog; default backlog)
  --complete <query>             complete (stops its timer first)
  --start <query>                start the single active timer
  --move <query> --to <section>  move a task (appends at the destination)
  --details <query> <body>       replace a task's details body (\"\" clears)
  --deploy                       force-push tasks.json now
  --sync-pull-peek               print the phone's pending captures
  --analytics [range] [--from D --to D] [--created] [--agent|--mine]
                                 [--project <name>] — the analytics dashboard:
                                 stats, splits, day ledger, the action log
  --journal [range]              the actual journal entries (##j), by day
  --settings [get <key> | set <key> <val>]   the settings store (no args: summary)
  --themes                        themes: id, name, colors, active marker
  --theme-create <name> k=hex...  create a theme (bg= elev= soft= hover= border=
                                  text= dim= faint= accent= done= danger=;
                                  missing shades come from the active theme)
  --theme <id|name>               activate a theme
  --views                         views: name, axes, active marker
  --view-create <name> k=v...     create a view (prio=1,2,3 agent=all|agent|mine
                                  project=<name|none> notes=on|off noteprio=…)
  --view-enter <name>             enter a view (the GUI follows on its next sync)
  --view-exit                     exit the active view
  --view-delete <name>            delete a view
  --demo                         run against the demo db (global modifier)";

fn usage() -> i32 {
    eprintln!("{USAGE}");
    1
}


// ---- Settings store (settings.json; app-level, not db-level) --------------
//
// The GUI's persisted preferences live in one JSON file beside the databases
// (see settings.rs) — these verbs are the agent's door into it: create
// themes and views, activate them, flip toggles. The GUI picks external
// writes up on its next 60s sync and re-skins/re-scopes live.

/// The settings store map, anchored at the REAL db's directory (settings are
/// the app's — `--demo` never redirects them, the same machine-level rule as
/// `CLI: Enable`).
fn store() -> anyhow::Result<std::collections::HashMap<String, String>> {
    settings::read(
        real_db_path()
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("cannot resolve the app directory"))?,
    )
}

/// The projects existence switch (Settings → Features). Off, the # verbs
/// refuse — the axis doesn't exist for the GUI either.
/// Whether a destination section exists (Settings → Features). CLI verbs
/// refuse identically to the GUI's routes.
fn section_enabled(name: &str) -> anyhow::Result<bool> {
    Ok(store()?.get(&format!("dayapp-sec-{}-enabled", name)).map(String::as_str) != Some("0"))
}

fn projects_enabled() -> anyhow::Result<bool> {
    Ok(store()?.get("dayapp-projects-enabled").map(String::as_str) != Some("0"))
}

fn store_set(key: &str, value: &str) -> anyhow::Result<()> {
    settings::set(
        real_db_path()
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("cannot resolve the app directory"))?,
        key,
        value,
    )
}

/// `--settings` / `--settings get <key>` / `--settings set <key> <value>`.
/// Bare, the interesting keys print grouped with their live values; get
/// prints one raw value; set writes any store key (the summary doubles as
/// the key reference).
fn settings_cmd(rest: &[String]) -> anyhow::Result<()> {
    let map = store()?;
    match rest.first().map(String::as_str) {
        None => {
            let get = |k: &str| map.get(k).cloned();
            let on = |k: &str| match get(k).as_deref() {
                Some("0") => "off",
                _ => "on",
            };
            println!("features:");
            for (k, label) in [
                ("dayapp-tasks-enabled", "tasks"),
                ("dayapp-sec-today-enabled", "today"),
                ("dayapp-sec-daily-enabled", "daily"),
                ("dayapp-sec-backlog-enabled", "backlog"),
                ("dayapp-notes-enabled", "notes"),
                ("dayapp-goals-enabled", "goals"),
                ("dayapp-journal-enabled", "journal"),
                ("dayapp-quotes-enabled", "quotes"),
            ] {
                println!("  {label:<10} {}", on(k));
            }
            println!("ui:");
            println!("  notes-bg   {}", on("dayapp-notes-card"));
            println!("  tasks-bg   {}", on("dayapp-tasks-card"));
            println!("  screensaver {} min idle", get("dayapp-screensaver-mins").unwrap_or_else(|| "2".into()));
            println!("  header     {}", get("dayapp-header-buttons").unwrap_or_else(|| "{}".into()));
            println!("theme:      {}", get("dayapp-theme").unwrap_or_else(|| "dark".into()));
            let views = get("dayapp-views").unwrap_or_else(|| "[]".into());
            let active = get("dayapp-active-view").unwrap_or_default();
            let n = serde_json::from_str::<serde_json::Value>(&views)
                .ok()
                .and_then(|v| v.as_array().cloned())
                .map(|a| a.len())
                .unwrap_or(0);
            println!("views:      {n} (active: {})", if active.is_empty() { "none" } else { &active });
            println!("\nset any key: dayapp --settings set <key> <value>");
        }
        Some("get") => {
            let key = rest.get(1).ok_or_else(|| anyhow::anyhow!("--settings get needs a <key>"))?;
            println!("{}", map.get(key).ok_or_else(|| anyhow::anyhow!("no value for {key}"))?);
        }
        Some("set") => {
            let key = rest.get(1).ok_or_else(|| anyhow::anyhow!("--settings set needs <key> <value>"))?;
            let value = rest.get(2).ok_or_else(|| anyhow::anyhow!("--settings set needs <key> <value>"))?;
            store_set(key, value)?;
            println!("set {key}");
        }
        _ => return Err(anyhow::anyhow!("usage: --settings [get <key> | set <key> <value>]")),
    }
    Ok(())
}

/// The theme JSON shape the GUI stores (dayapp-themes array entries).
const THEME_SHADES: [&str; 11] = [
    "bg", "bgElev", "bgSoft", "bgHover", "border", "text", "textDim", "textFaint",
    "accent", "done", "danger",
];

fn read_themes(map: &std::collections::HashMap<String, String>) -> anyhow::Result<Vec<serde_json::Value>> {
    let raw = map.get("dayapp-themes").map(String::as_str).unwrap_or("[]");
    Ok(serde_json::from_str(raw)?)
}

fn write_themes(themes: &[serde_json::Value]) -> anyhow::Result<()> {
    store_set("dayapp-themes", &serde_json::to_string(themes)?)
}

/// The active theme's colors as a serde object — the base a --theme-create
/// starts from (missing shades inherit).
fn active_theme_colors(
    map: &std::collections::HashMap<String, String>,
) -> anyhow::Result<serde_json::Map<String, serde_json::Value>> {
    let active_id = map.get("dayapp-theme").map(String::as_str).unwrap_or("dark");
    let themes = read_themes(map)?;
    let mut all: Vec<serde_json::Value> = vec![
        serde_json::json!({ "id": "dark", "name": "Dark",
          "colors": { "bg": "#0e0f11", "bgElev": "#16181c", "bgSoft": "#121417", "bgHover": "#1c1f24",
                      "border": "#30343c", "text": "#d2d5da", "textDim": "#a2a7b1", "textFaint": "#7b7f88",
                      "accent": "#7b8cff", "done": "#3a3f48", "danger": "#e5484d" } }),
        serde_json::json!({ "id": "light", "name": "Light",
          "colors": { "bg": "#f7f7f8", "bgElev": "#ffffff", "bgSoft": "#f0f0f2", "bgHover": "#e9e9ed",
                      "border": "#d9dade", "text": "#212327", "textDim": "#5d6167", "textFaint": "#90949b",
                      "accent": "#5061f5", "done": "#b3b7bf", "danger": "#d7383f" } }),
    ];
    all.extend(themes);
    let found = all
        .iter()
        .find(|t| t["id"].as_str() == Some(active_id))
        .or_else(|| all.first());
    let colors = found
        .ok_or_else(|| anyhow::anyhow!("no theme to inherit from"))?
        .get("colors")
        .cloned()
        .unwrap_or_default();
    Ok(colors.as_object().cloned().unwrap_or_default())
}

fn themes_cmd() -> anyhow::Result<()> {
    let map = store()?;
    let active = map.get("dayapp-theme").map(String::as_str).unwrap_or("dark");
    let mut all: Vec<serde_json::Value> = vec![
        serde_json::json!({ "id": "dark", "name": "Dark" }),
        serde_json::json!({ "id": "light", "name": "Light" }),
    ];
    all.extend(read_themes(&map)?);
    all.sort_by_key(|t| t["id"].as_str() != Some(active));
    for t in &all {
        let id = t["id"].as_str().unwrap_or("?");
        let name = t["name"].as_str().unwrap_or("?");
        let mark = if id == active { " ←active" } else { "" };
        if let Some(colors) = t.get("colors").and_then(|c| c.as_object()) {
            let shades: Vec<String> = THEME_SHADES
                .iter()
                .filter_map(|k| colors.get(*k).and_then(|v| v.as_str()).map(|v| format!("{k}={v}")))
                .collect();
            println!("{id:<14} {name}{mark}\n  {}", shades.join(" "));
        } else {
            println!("{id:<14} {name} (built-in){mark}");
        }
    }
    Ok(())
}

fn theme_create(rest: &[String]) -> anyhow::Result<()> {
    let name = rest
        .first()
        .ok_or_else(|| anyhow::anyhow!("--theme-create needs a <name> then shade=hex pairs"))?;
    let mut map = store()?;
    let mut colors = active_theme_colors(&map)?;
    for arg in &rest[1..] {
        let (k, v) = arg
            .split_once('=')
            .ok_or_else(|| anyhow::anyhow!("shades are key=value ({arg:?})"))?;
        if !THEME_SHADES.contains(&k) {
            return Err(anyhow::anyhow!("unknown shade {k:?} — one of {}", THEME_SHADES.join(" ")));
        }
        let v = v.to_lowercase();
        let ok = (v.len() == 7 || v.len() == 4)
            && v.starts_with('#')
            && v[1..].chars().all(|c| c.is_ascii_hexdigit());
        if !ok {
            return Err(anyhow::anyhow!("{k}={v} is not a hex color"));
        }
        colors.insert(k.to_string(), serde_json::Value::String(v));
    }
    let id = format!("{}-{}", name.to_lowercase().replace(' ', "-"), ulid::Ulid::new().to_string().to_lowercase());
    let theme = serde_json::json!({ "id": id, "name": name, "colors": colors });
    let mut themes = read_themes(&map)?;
    themes.push(theme);
    write_themes(&themes)?;
    // Creating implies activating — the GUI's New Theme flow does the same.
    store_set("dayapp-theme", &id)?;
    println!("created + activated {id}");
    Ok(())
}

fn theme_activate(rest: &[String]) -> anyhow::Result<()> {
    let q = rest.first().ok_or_else(|| anyhow::anyhow!("--theme needs an id or name"))?;
    let map = store()?;
    let q_lower = q.to_lowercase();
    let mut all: Vec<serde_json::Value> = vec![
        serde_json::json!({ "id": "dark", "name": "Dark" }),
        serde_json::json!({ "id": "light", "name": "Light" }),
    ];
    all.extend(read_themes(&map)?);
    let hit = all
        .iter()
        .find(|t| t["id"].as_str() == Some(q.as_str()))
        .or_else(|| {
            all.iter()
                .find(|t| t["name"].as_str().map(|n| n.to_lowercase()) == Some(q_lower.clone()))
        })
        .or_else(|| {
            all.iter().find(|t| {
                t["name"]
                    .as_str()
                    .map(|n| n.to_lowercase().contains(&q_lower))
                    .unwrap_or(false)
            })
        });
    let id = hit
        .and_then(|t| t["id"].as_str())
        .ok_or_else(|| anyhow::anyhow!("no theme matching {q:?}"))?
        .to_string();
    store_set("dayapp-theme", &id)?;
    println!("theme set to {id} — the GUI follows on its next sync");
    Ok(())
}

/// The custom views array (dayapp-views), shaped exactly like the GUI's
/// CustomView in SettingsView.tsx.
fn read_views(map: &std::collections::HashMap<String, String>) -> anyhow::Result<Vec<serde_json::Value>> {
    let raw = map.get("dayapp-views").map(String::as_str).unwrap_or("[]");
    Ok(serde_json::from_str(raw)?)
}

fn write_views(views: &[serde_json::Value]) -> anyhow::Result<()> {
    store_set("dayapp-views", &serde_json::to_string(views)?)
}

fn views_cmd() -> anyhow::Result<()> {
    let map = store()?;
    let active = map.get("dayapp-active-view").map(String::as_str).unwrap_or("");
    for v in read_views(&map)? {
        let id = v["id"].as_str().unwrap_or("?");
        let name = v["name"].as_str().unwrap_or("?");
        let mark = if id == active { " ←active" } else { "" };
        let prios: Vec<String> = v["priorities"]
            .as_array()
            .map(|a| a.iter().filter_map(|p| p.as_i64()).map(|p| p.to_string()).collect())
            .unwrap_or_default();
        let np: Vec<String> = v["notePriorities"]
            .as_array()
            .map(|a| a.iter().filter_map(|p| p.as_i64()).map(|p| p.to_string()).collect())
            .unwrap_or_default();
        println!(
            "{name}{mark}\n  prio={} agent={} project={} notes={} noteprio={}",
            if prios.is_empty() { "none".into() } else { prios.join(",") },
            v["agent"].as_str().unwrap_or("all"),
            v["projectId"].as_str().unwrap_or("any"),
            if v["notes"].as_bool().unwrap_or(true) { "on" } else { "off" },
            if np.is_empty() { "none".into() } else { np.join(",") },
        );
    }
    Ok(())
}

fn view_create(db: &Db, rest: &[String]) -> anyhow::Result<()> {
    let name = rest
        .first()
        .ok_or_else(|| anyhow::anyhow!("--view-create needs a <name> then key=value axes"))?;
    let (mut prios, mut agent, mut project, mut notes, mut np): (Vec<i64>, String, Option<String>, bool, Vec<i64>) =
        (vec![1, 2, 3], "all".into(), None, true, vec![1, 2, 3]);
    for arg in &rest[1..] {
        let (k, v) = arg
            .split_once('=')
            .ok_or_else(|| anyhow::anyhow!("axes are key=value ({arg:?})"))?;
        match k {
            "prio" | "priorities" => prios = parse_tiers(v)?,
            "noteprio" | "notepriorities" => np = parse_tiers(v)?,
            "agent" => match v {
                "all" | "agent" | "mine" => agent = v.to_string(),
                other => return Err(anyhow::anyhow!("agent is all|agent|mine, not {other:?}")),
            },
            "project" => {
                if !projects_enabled()? {
                    return Err(anyhow::anyhow!("projects are off in settings — views can't scope to one"));
                }
                project = if v.eq_ignore_ascii_case("none") || v.eq_ignore_ascii_case("any") {
                    None
                } else {
                    let pid: String = db
                        .conn
                        .lock()
                        .unwrap()
                        .query_row(
                            "SELECT id FROM projects WHERE lower(name) = lower(?1)",
                            params![v],
                            |r| r.get::<_, String>(0),
                        )
                        .optional()?
                        .ok_or_else(|| anyhow::anyhow!("no project named {v:?}"))?;
                    Some(pid)
                };
            }
            "notes" => match v {
                "on" | "off" => notes = v == "on",
                other => return Err(anyhow::anyhow!("notes is on|off, not {other:?}")),
            },
            other => return Err(anyhow::anyhow!("unknown axis {other:?} — prio agent project notes noteprio")),
        }
    }
    let id = format!("{}-{}", name.to_lowercase().replace(' ', "-"), ulid::Ulid::new().to_string().to_lowercase());
    let mut map = store()?;
    let mut views = read_views(&map)?;
    views.push(serde_json::json!({
        "id": id, "name": name,
        "priorities": prios, "agent": agent,
        "projectId": project, "notes": notes, "notePriorities": np,
    }));
    write_views(&views)?;
    println!("created view {id} — enter it with --view-enter {name:?}");
    Ok(())
}

fn parse_tiers(v: &str) -> anyhow::Result<Vec<i64>> {
    let mut out = Vec::new();
    for part in v.split(',') {
        let t: i64 = part.trim().parse()?;
        if !(1..=3).contains(&t) {
            return Err(anyhow::anyhow!("tiers are 1..3, not {t}"));
        }
        if !out.contains(&t) {
            out.push(t);
        }
    }
    Ok(out)
}

/// `--view-enter <name>` / `--view-exit`: the active-view id in the store —
/// the GUI's next sync re-scopes to it (or out of any view).
fn view_set_active(rest: &[String], enter: bool) -> anyhow::Result<()> {
    if !enter {
        store_set("dayapp-active-view", "")?;
        println!("view exited — the GUI follows on its next sync");
        return Ok(());
    }
    let q = rest.first().ok_or_else(|| anyhow::anyhow!("--view-enter needs a view name"))?;
    let map = store()?;
    let q_lower = q.to_lowercase();
    let views = read_views(&map)?;
    let hit = views
        .iter()
        .find(|v| {
            v["name"].as_str().map(|n| n.to_lowercase()) == Some(q_lower.clone())
                || v["id"].as_str() == Some(q.as_str())
        })
        .or_else(|| {
            views.iter().find(|v| {
                v["name"]
                    .as_str()
                    .map(|n| n.to_lowercase().contains(&q_lower))
                    .unwrap_or(false)
            })
        });
    let id = hit
        .and_then(|v| v["id"].as_str())
        .ok_or_else(|| anyhow::anyhow!("no view matching {q:?}"))?
        .to_string();
    store_set("dayapp-active-view", &id)?;
    println!("entered {id} — the GUI follows on its next sync");
    Ok(())
}

fn view_delete(rest: &[String]) -> anyhow::Result<()> {
    let q = rest.first().ok_or_else(|| anyhow::anyhow!("--view-delete needs a view name"))?;
    let mut map = store()?;
    let q_lower = q.to_lowercase();
    let views = read_views(&map)?;
    let keep: Vec<serde_json::Value> = views
        .iter()
        .filter(|v| {
            let name_hit = v["name"].as_str().map(|n| n.to_lowercase()) == Some(q_lower.clone());
            let id_hit = v["id"].as_str() == Some(q.as_str());
            !(name_hit || id_hit)
        })
        .cloned()
        .collect();
    if keep.len() == views.len() {
        return Err(anyhow::anyhow!("no view matching {q:?}"));
    }
    let active = map.get("dayapp-active-view").cloned().unwrap_or_default();
    write_views(&keep)?;
    if keep.iter().all(|v| v["id"].as_str() != Some(active.as_str())) {
        store_set("dayapp-active-view", "")?;
    }
    println!("deleted");
    Ok(())
}

/// `--journal [today|week|month|all|YYYY-MM-DD]` — the ACTUAL journal: the
/// ##j lines he wrote (the entries table, the Journal view's content),
/// grouped by day newest-first. Not the action log — that's `--analytics`.
fn journal_entries(db: &Db, range: Option<&str>) -> anyhow::Result<()> {
    use chrono::{Duration, NaiveDate};
    let today = NaiveDate::parse_from_str(&crate::db::today_iso(), "%Y-%m-%d")?;
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
    let in_range = |day: &str| -> bool {
        let Ok(d) = NaiveDate::parse_from_str(day, "%Y-%m-%d") else { return false };
        since.map_or(true, |s| d >= s) && until.map_or(true, |u| d < u)
    };

    let mut entries: Vec<crate::journal::Entry> = db
        .list_entries()?
        .into_iter()
        .filter(|e| e.kind == "journal" && in_range(&e.day))
        .collect();
    if entries.is_empty() {
        println!("no journal entries in this range.");
        return Ok(());
    }
    // Day groups newest-first, entries in capture order within a day (the
    // Journal view's shape).
    entries.sort_by(|a, b| b.day.cmp(&a.day).then_with(|| a.created_at.cmp(&b.created_at)));
    let mut current: Option<String> = None;
    for e in &entries {
        if current.as_deref() != Some(e.day.as_str()) {
            current = Some(e.day.clone());
            let label = if e.day == crate::db::today_iso() {
                "Today".to_string()
            } else {
                NaiveDate::parse_from_str(&e.day, "%Y-%m-%d")
                    .map(|d| d.format("%a, %b %-d").to_string())
                    .unwrap_or_else(|_| e.day.clone())
            };
            println!("{label}");
        }
        println!("  {}", e.text);
    }
    Ok(())
}

/// Snapshot the real db into backups/ (see backup.rs). Refuses while --demo is
/// active. Prints the new file's path so a remote session can scp it off the
/// machine — the GUI's ⌘P capture is this same code path.
fn backup_cmd(db: &Db) -> anyhow::Result<()> {
    let path = crate::backup::capture(db)?;
    println!("{}", path.display());
    Ok(())
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
        if !projects_enabled()? {
            return Err(anyhow::anyhow!("projects are off in settings — no # axis to search"));
        }
        return search_project(db, name.trim());
    }
    if let Some(mode) = trimmed.strip_prefix('@') {
        if store().ok().and_then(|m| m.get("dayapp-agent-enabled").cloned()) == Some("0".into()) {
            return Err(anyhow::anyhow!("agent delegation is off in settings — no @ axis to search"));
        }
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
fn analytics(db: &Db, rest: &[String]) -> anyhow::Result<()> {
    use chrono::{Duration, NaiveDate};
    use std::collections::BTreeSet;
    // Flags first, then an optional preset range. --from/--to win when given
    // (the GUI's custom window); a preset names the window otherwise.
    let mut range: Option<&str> = None;
    let mut from: Option<&str> = None;
    let mut to: Option<&str> = None;
    let mut created = false;
    let mut agent: Option<bool> = None;
    let mut project: Option<String> = None;
    let mut it = rest.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--created" => created = true,
            "--agent" => agent = Some(true),
            "--mine" => agent = Some(false),
            "--project" => {
                if !projects_enabled()? {
                    return Err(anyhow::anyhow!("projects are off in settings — no --project scope"));
                }
                project = Some(
                    it.next()
                        .ok_or_else(|| anyhow::anyhow!("--project needs a name"))?
                        .clone(),
                );
            }
            "--from" => from = Some(it.next().ok_or_else(|| anyhow::anyhow!("--from needs a date"))?),
            "--to" => to = Some(it.next().ok_or_else(|| anyhow::anyhow!("--to needs a date"))?),
            other => {
                if range.is_some() {
                    return Err(anyhow::anyhow!("unexpected argument {other:?}"));
                }
                range = Some(other);
            }
        }
    }
    // The app's day runs 6am→6am — `today_iso()` is the logical today, so a
    // late-night session still reads as "today" at 1am.
    let today = NaiveDate::parse_from_str(&crate::db::today_iso(), "%Y-%m-%d")?;
    let tomorrow = today + Duration::days(1);
    let parse_day = |d: &str| {
        NaiveDate::parse_from_str(d, "%Y-%m-%d")
            .map_err(|_| anyhow::anyhow!("{d} is not a YYYY-MM-DD date"))
    };
    let (since, until): (Option<NaiveDate>, Option<NaiveDate>) = match (from, to) {
        (Some(f), Some(t)) => (Some(parse_day(f)?), Some(parse_day(t)? + Duration::days(1))),
        (Some(f), None) => (Some(parse_day(f)?), None),
        (None, Some(t)) => (None, Some(parse_day(t)? + Duration::days(1))),
        (None, None) => match range {
            None | Some("today") => (Some(today), Some(tomorrow)),
            Some("week") => (Some(today - Duration::days(6)), Some(tomorrow)),
            Some("month") => (Some(today - Duration::days(29)), Some(tomorrow)),
            Some("all") => (None, None),
            Some(day) => {
                let d = parse_day(day)?;
                (Some(d), Some(d + Duration::days(1)))
            }
        },
    };
    let iso = |d: Option<NaiveDate>| d.map(|x| x.format("%Y-%m-%d").to_string());

    // The agent axis reads the items' current flags — assignments are
    // unlogged, the one "currently" read (see dashboard.rs).
    let filter = crate::dashboard::ScopeFilter {
        projects: project.as_ref().map(|_| vec![project.clone()]),
        priorities: None,
        agent,
    };
    let subject = if created {
        crate::dashboard::Subject::Created
    } else {
        crate::dashboard::Subject::Done
    };
    let dash = db.journal_dashboard(
        iso(since).as_deref(),
        iso(until).as_deref(),
        &filter,
        subject,
    )?;
    let noun = if created { "created" } else { "done" };
    let days = dash.days.len().max(1);
    let window = match (iso(since), iso(until)) {
        (Some(a), Some(b)) => format!("{} → {}", a, b),
        (Some(a), None) => format!("{a} → open"),
        (None, Some(b)) => format!("start → {b}"),
        (None, None) => "all time".into(),
    };
    println!("analytics · {noun} · {window}");
    let mut stats = format!(
        "{} {noun} · avg/day {:.1} · streak {}",
        dash.totals.count,
        dash.totals.count as f64 / days as f64,
        dash.totals.streak
    );
    if !created {
        stats.push_str(&format!(
            " · daily missed {} · today missed {}",
            dash.totals.daily_missed, dash.totals.today_missed
        ));
    }
    println!("{stats}");
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
    let owner = db
        .meta_get("owner_name")
        .ok()
        .flatten()
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "Mine".to_string());
    println!(
        "delegation: agent {} · {} {}",
        dash.agents.agent, owner, dash.agents.mine
    );
    println!();

    let actions = db.list_actions(None, iso(since).as_deref(), iso(until).as_deref())?;
    let times = db.session_time_by_day(iso(since).as_deref(), iso(until).as_deref())?;

    // The set of days is the union of action days and time days — a day with
    // only tracked time still shows up (same rule as JournalView).
    let mut day_set: BTreeSet<String> = BTreeSet::new();
    for a in &actions {
        if let Some(day) = crate::db::day_key_of_ts(&a.timestamp) {
            day_set.insert(day);
        }
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
            if d.count > 0 {
                header += &format!(" · {} done", d.count);
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
        "paused" => "paused",
        "unpaused" => "unpaused",
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
    if !projects_enabled()? {
        println!("projects are off in settings");
        return Ok(());
    }
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

/// Open the shared db — the same path the GUI resolves through Tauri's
/// app_data_dir: ~/Library/Application Support/<identifier> on macOS,
/// ${XDG_DATA_HOME:-~/.local/share}/<identifier> elsewhere. Older macOS
/// installs may have used the product name, so accept both there.
/// With `demo`, opens the sibling demo db instead (created + seeded on first
/// use — the same dataset as ⌘P → Enter Demo Mode).
fn real_db_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let base = if cfg!(target_os = "macos") {
        std::path::PathBuf::from(home).join("Library/Application Support")
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from(&home).join(".local/share"))
    };
    let mut candidates = vec![base.join("com.farazshah.dayapp").join("dayapp.db")];
    if cfg!(target_os = "macos") {
        candidates.push(base.join("DayApp").join("dayapp.db"));
    }
    Some(
        candidates
            .iter()
            .find(|p| p.exists())
            .cloned()
            .unwrap_or_else(|| candidates[0].clone()),
    )
}

fn open_db(demo_mode: bool) -> Option<Db> {
    let real = real_db_path()?;
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
        if !section_enabled(s)? {
            anyhow::bail!("the {s} section is off in settings");
        }
    }
    let filter = if hidden { HiddenFilter::Include } else { HiddenFilter::Exclude };
    let rows: Vec<(Item, &'static str)> = all_items(db, filter)?
        .into_iter()
        .filter(|(_, sec)| section.as_deref().map_or(true, |s| s == *sec))
        .filter(|(_, sec)| section_enabled(sec).unwrap_or(true))
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
    static FLAGS: std::sync::OnceLock<(bool, bool, bool)> = std::sync::OnceLock::new();
    let (prio_on, agent_on, proj_on) = FLAGS.get_or_init(|| {
        let flag = |k: &str| store().ok().and_then(|m| m.get(k).cloned()) != Some("0".into());
        (
            flag("dayapp-task-priorities-enabled"),
            flag("dayapp-agent-enabled"),
            flag("dayapp-projects-enabled"),
        )
    });
    row_meta_in(item, projects, *prio_on, *agent_on, *proj_on)
}

/// The axis-aware variant: existence switches off (Settings → Features), the
/// marks vanish — the CLI mirrors what the GUI shows.
fn row_meta_in(
    item: &Item,
    projects: &std::collections::HashMap<String, String>,
    priorities: bool,
    agent_axis: bool,
    project_axis: bool,
) -> String {
    let prio = if priorities {
        item.priority.map(|p| format!(" !{p}")).unwrap_or_default()
    } else {
        String::new()
    };
    // The delegation axis: 🤖 marks rows assigned to the AI agent, so an
    // agent (or Faraz over SSH) can see which tasks are theirs to take.
    let agent = if agent_axis && item.assigned_to_agent { "🤖 " } else { "" };
    let proj = if project_axis {
        item.project_id
            .as_ref()
            .and_then(|id| projects.get(id).map(|n| format!(" #{n}")))
            .unwrap_or_default()
    } else {
        String::new()
    };
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
    // A Daily row's ⏱ is today's tracked time (the 6am→6am day, like the
    // completion reset) — the same number the GUI renders; other sections
    // keep the all-time total.
    let totals = if sec == "daily" {
        db.today_totals(&[item.id.clone()])
    } else {
        db.time_totals(&[item.id.clone()])
    };
    if let Ok(totals) = totals {
        if let Some(secs) = totals.get(&item.id) {
            if *secs > 0 {
                println!("  ⏱ {}", fmt_duration(*secs));
            }
        }
    }
    if let Some(r) = item.remind_at.as_deref() {
        if store()?.get("dayapp-reminders-enabled").map(String::as_str) != Some("0") {
            println!("  remind {}", pretty_date(r));
        }
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
            if !section_enabled(&section)? {
                anyhow::bail!("the {section} section is off in settings");
            }
        } else {
            text = Some(a.clone());
        }
    }
    let text = text.ok_or_else(|| anyhow::anyhow!("--add needs quoted text"))?;
    if text.trim().is_empty() {
        anyhow::bail!("empty text");
    }
    let item = db.create_item(text.trim(), &section, None, None)?; // --add stores text raw — no token parsing, so no birth axes
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
    if !section_enabled(&to)? {
        anyhow::bail!("the {to} section is off in settings");
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

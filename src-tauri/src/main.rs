// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Headless CLI entry (SSH/zcode remote access): `dayapp --list`, `--add`,
    // `--complete`, `--start` run against the shared db and exit. A launch
    // without flags opens the GUI as usual. (macOS sometimes passes a legacy
    // -psn_* arg — filtered out.)
    let args: Vec<String> = std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with("-psn_"))
        .collect();
    if !args.is_empty() {
        std::process::exit(dayapp_lib::cli::run(args));
    }
    dayapp_lib::run()
}

// App-level commands: the launch sweep, the release/self update channel, the
// masthead owner name, the CLI installer, the window chrome — plus demo mode
// and backups, the two real-data-only features that ride the same "system"
// tier. No domain data crosses this file.

import { invoke } from "@tauri-apps/api/core";

export const systemApi = {
  /** The 6am-boundary sweep + reminder promotion (the 60s tick's call). */
  runSweep: () => invoke<number>("run_sweep"),
  selfUpdate: () => invoke<void>("self_update"),
  /** Release channel (no source checkout): see the three lib.rs commands. */
  updateSourceAvailable: () => invoke<boolean>("update_source_available"),
  updateCheck: () => invoke<string | null>("update_check"),
  updateInstall: () => invoke<void>("update_install"),
  /** Masthead owner: null = never asked, "" = asked and skipped. */
  getOwnerName: () => invoke<string | null>("get_owner_name"),
  setOwnerName: (name: string) => invoke<void>("set_owner_name", { name }),
  /** Install the `dayapp` shell command; returns the toast message. */
  cliInstall: () => invoke<string>("cli_install"),
  /** The native title bar (desktop only). */
  setWindowDecorations: (on: boolean) => invoke<void>("set_window_decorations", { on }),
};

// ---- Demo mode --------------------------------------------------------------
// A second, disposable db (dayapp-demo.db) swapped in by the backend under the
// connection lock. Session-only (a launch always opens the real db); demo data
// persists across sessions and "Reset Demo Data" re-seeds it. The backend emits
// a "demo-mode" event on every toggle/reset so the shell can re-pull everything.

export const demoApi = {
  active: () => invoke<boolean>("demo_mode"),
  enter: () => invoke<void>("enter_demo_mode"),
  exit: () => invoke<void>("exit_demo_mode"),
  reset: () => invoke<void>("reset_demo_data"),
};

// ---- Backups ------------------------------------------------------------------
// Point-in-time snapshots of the real db (⌘P → Backups: Capture Now /
// dayapp --backup). Capture-only — no restore surface yet; files land in
// backups/ beside the db. Gated in demo mode like mobile sync.

export const backupApi = {
  /** Captures a snapshot and resolves with the new file's absolute path. */
  capture: () => invoke<string>("capture_backup"),
  reveal: () => invoke<void>("reveal_backups"),
};

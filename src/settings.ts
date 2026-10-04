// settings.ts — the GUI's window into the settings store (settings.json
// beside the databases; see src-tauri/src/settings.rs). Replaces localStorage
// for every persisted UI preference: the app's state initializers read the
// cache synchronously (initSettings must run first — App gates on it), and
// the persist effects write through, updating the cache and the known-file
// snapshot in one step.
//
// The known snapshot is what the 60s tick diffs against: an agent changing
// settings over SSH lands in the file, the tick sees a snapshot mismatch and
// reloads the webview — the one path that re-initializes every state hook
// cleanly. The GUI's own writes refresh the snapshot, so they never
// self-trigger.

import { invoke } from "@tauri-apps/api/core";

let cache: Record<string, string> = {};
let known = "";

// The canonical form the tick compares — sorted pairs, immune to the
// backend's HashMap key order.
const canon = (m: Record<string, string>) =>
  JSON.stringify(Object.keys(m).sort().map((k) => [k, m[k]]));

/** Fetch the store into the cache. Returns true when the file was EMPTY —
 *  the caller's one-time cue to seed an upgrade's localStorage prefs in. */
export async function initSettings(): Promise<boolean> {
  cache = await invoke<Record<string, string>>("settings_get");
  known = canon(cache);
  return Object.keys(cache).length === 0;
}

/** Synchronous read — valid only after initSettings (App gates on it). */
export function sget(key: string, dflt: string): string {
  return cache[key] ?? dflt;
}

/** Write-through: cache first (same-process reads are fresh), then the file
 *  (fire-and-forget — a failed write logs and the 60s tick state stays the
 *  source of truth on next launch). */
export function sset(key: string, value: string): void {
  cache[key] = value;
  known = canon(cache);
  invoke("settings_set", { entries: { [key]: value } }).catch((e) =>
    console.error("[dayapp] settings write failed", e),
  );
}

export function ssetMany(entries: Record<string, string>): void {
  for (const [k, v] of Object.entries(entries)) cache[k] = v;
  known = canon(cache);
  invoke("settings_set", { entries }).catch((e) =>
    console.error("[dayapp] settings seed failed", e),
  );
}

/** True when the file differs from what this process last knew — an external
 *  (CLI/agent) write. The caller reloads the webview to apply it. */
export async function externallyChanged(): Promise<boolean> {
  try {
    const file = await invoke<Record<string, string>>("settings_get");
    return canon(file) !== known;
  } catch {
    return false;
  }
}

/** The keys that migrated from localStorage (2026-10-05). zoom and the
 *  notes-collapse set stay local — machine/display minutiae, not settings. */
export const MIGRATED_KEYS = [
  "dayapp-goals-visible", "dayapp-notes-visible", "dayapp-tasks-visible",
  "dayapp-sec-today", "dayapp-sec-daily", "dayapp-sec-backlog",
  "dayapp-hidden-items", "dayapp-hidden-notes",
  "dayapp-hidden-priorities", "dayapp-hidden-note-priorities",
  "dayapp-focus-mode", "dayapp-fun-mode", "dayapp-agent-tasks-visible",
  "dayapp-goals-enabled", "dayapp-notes-enabled", "dayapp-tasks-enabled",
  "dayapp-sec-today-enabled", "dayapp-sec-daily-enabled", "dayapp-sec-backlog-enabled",
  "dayapp-notes-card", "dayapp-tasks-card", "dayapp-header-buttons",
  "dayapp-views", "dayapp-active-view", "dayapp-theme", "dayapp-themes",
  "dayapp-journal-enabled", "dayapp-quotes-enabled", "dayapp-quote-screensaver",
];

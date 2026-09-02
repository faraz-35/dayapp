// devlog — the interaction trace. While recording, every semantic UI
// interaction (a capture committed, a row focused, an edit started, a drag
// landed, a palette command run, …) is appended as one JSON line to a
// session file in the app log dir. It records the layer neither existing log
// knows: `actions` holds the domain fact (a task was completed), the
// rotating app log holds lifecycle — the dev log holds the INTERACTION
// (via which key, on which surface, what the palette ran). Recording is
// demo-scoped: it auto-arms when demo mode opens (fresh file each entry, so
// t=0 is the demo's t=0 — the studio aligns subtitles against it), disarms
// on exit, and ⌘P → "Dev Log: Start/Stop Recording" toggles it mid-session.
// Nothing renders it — the file is the artifact, for agents (tail it) and
// the studio pipeline (cue sheets).
//
// Discipline, per the logging convention: semantic verbs only, and
// app-driven churn (the 1s timer tick, the 60s sweep, the masthead
// rotation) never traces — DOM churn is not attention. A paused trace costs
// one boolean check per call, so call sites trace unconditionally and this
// module drops events while recording is off.

import { invoke } from "@tauri-apps/api/core";
import { log } from "./log";

export type DevlogDetail = Record<string, unknown>;

// Batch window: interactions arrive in small bursts (one gesture = 1–3
// events), so a quarter-second coalesce keeps the IPC count trivial without
// ever losing the tail that matters.
const FLUSH_MS = 250;

let recording = false;
// Kept through stop() so the final flush still knows where to write.
let file: string | null = null;
let t0 = 0;
let buffer: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export const devlogActive = (): boolean => recording;

/** Start a fresh recording: new timestamped file, t=0 now. Returns the file
 *  name (relative to the app log dir). A no-op when already recording. */
export async function devlogStart(): Promise<string> {
  if (recording && file) return file;
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  file = `devlog-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.jsonl`;
  t0 = Date.now();
  recording = true;
  trace("devlog.start");
  await flushNow();
  log.info(`devlog: recording → ${file} (app log dir)`);
  return file;
}

/** Flush and close the recording. A no-op when not recording. */
export async function devlogStop(): Promise<void> {
  if (!recording) return;
  trace("devlog.stop");
  recording = false;
  await flushNow();
  log.info("devlog: recording stopped");
}

/** Record one interaction. `kind` is a dotted family.verb ("capture.task",
 *  "focus.task", "palette.exec", …); detail carries the specifics (ids,
 *  text payloads, addresses). Dropped silently while not recording. */
export function trace(kind: string, detail?: DevlogDetail): void {
  if (!recording) return;
  const evt: Record<string, unknown> = {
    t: Math.round((Date.now() - t0)) / 1000,
    ts: new Date().toISOString(),
    kind,
  };
  if (detail && Object.keys(detail).length > 0) evt.detail = detail;
  buffer.push(JSON.stringify(evt));
  if (!flushTimer) flushTimer = setTimeout(flushNow, FLUSH_MS);
}

/** Bound a text payload — the trace is a story, not a store. */
export const clip = (s: string, max = 160): string =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;

async function flushNow(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (buffer.length === 0 || !file) return;
  const lines = buffer;
  buffer = [];
  try {
    await invoke("devlog_append", { file, lines });
  } catch (e) {
    // The trace must never break the app: drop the batch, say so once.
    log.warn("devlog: append failed", e);
  }
}

// Best-effort tail flush when the window goes away (quit, hide) — the
// at-most FLUSH_MS of buffered events usually survive, which is everything
// except a quit mid-gesture.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) void flushNow();
  });
}

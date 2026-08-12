// Typed wrapper over the Tauri invoke bridge.
// Every Rust #[tauri::command] in src-tauri/src/lib.rs has a mirror here.

import { invoke } from "@tauri-apps/api/core";

export type Section = "today" | "daily" | "backlog";
export type Status = "active" | "done";

/** Hide duration. `forever` hides until manually unhidden; the rest auto-restore
 *  at the start of the named period's end date (day = tomorrow, etc.). */
export type HideDuration = "forever" | "day" | "week" | "month";

export interface Item {
  id: string;
  text: string;
  section: Section;
  status: Status;
  lastCompletedDate: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  hidden: boolean;
  hiddenUntil: string | null;
  projectId: string | null;
  remindAt: string | null;
}

export interface Action {
  id: number;
  itemId: string;
  itemText: string;
  action: string;
  fromSection?: string;
  toSection?: string;
  fromStatus?: string;
  toStatus?: string;
  timestamp: string;
}

// Rust uses serde(rename_all = "camelCase"), so the camelCase fields match.
export const api = {
  listItems: (section: Section, includeDone = false) =>
    invoke<Item[]>("list_items", { section, includeDone }),
  createItem: (text: string, section: Section) =>
    invoke<Item>("create_item", { text, section }),
  editItem: (id: string, text: string) =>
    invoke<void>("edit_item", { id, text }),
  completeItem: (id: string) => invoke<void>("complete_item", { id }),
  moveItem: (id: string, toSection: Section, newIndex: number) =>
    invoke<void>("move_item", { id, toSection, newIndex }),
  deleteItem: (id: string) => invoke<void>("delete_item", { id }),
  hideItem: (id: string, duration: HideDuration) =>
    invoke<void>("hide_item", { id, duration }),
  unhideItem: (id: string) => invoke<void>("unhide_item", { id }),
  listHiddenItems: () => invoke<Item[]>("list_hidden_items"),
  setItemProject: (id: string, projectId: string | null) =>
    invoke<void>("set_item_project", { id, projectId }),
  setReminder: (id: string, remindAt: string | null) =>
    invoke<void>("set_reminder", { id, remindAt }),
  runSweep: () => invoke<number>("run_sweep"),
  listActions: (opts: { since?: string; until?: string; limit?: number } = {}) =>
    invoke<Action[]>("list_actions", {
      limit: opts.limit ?? 500,
      since: opts.since ?? null,
      until: opts.until ?? null,
    }),
  selfUpdate: () => invoke<void>("self_update"),
};

export interface Project {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: string;
}

// Projects: a second organising axis alongside Sections. Assignment is
// housekeeping (not logged), mirroring the hide affordance.
export const projectsApi = {
  list: () => invoke<Project[]>("list_projects"),
  create: (name: string) => invoke<Project>("create_project", { name }),
  rename: (id: string, name: string) => invoke<void>("rename_project", { id, name }),
  delete: (id: string) => invoke<void>("delete_project", { id }),
};

// ---- Timers --------------------------------------------------------------
// Per-task time tracking. A session is an interval of focused work on one
// item; exactly one may be open at a time (the single active timer). Sessions
// are measurement (content), not item-state, so they are NOT logged to
// `actions` — the journal reads them via sessionTimeByDay. See
// src-tauri/src/timers.rs.

export interface ActiveTimer {
  itemId: string;
  itemText: string;
  startedAt: string;
}

export interface DayTaskTime {
  day: string; // YYYY-MM-DD
  itemId: string;
  itemText: string;
  seconds: number;
}

export const timersApi = {
  start: (itemId: string) => invoke<ActiveTimer>("start_timer", { itemId }),
  stop: () => invoke<void>("stop_timer"),
  discard: () => invoke<void>("discard_timer"),
  active: () => invoke<ActiveTimer | null>("get_active_timer"),
  /** Total seconds per item for the visible rows, including the live elapsed of
   *  the running session. Keys are item ids; absent = 0. */
  totals: (itemIds: string[]) =>
    invoke<Record<string, number>>("time_totals", { itemIds }),
  sessionTimeByDay: (opts: { since?: string; until?: string } = {}) =>
    invoke<DayTaskTime[]>("session_time_by_day", {
      since: opts.since ?? null,
      until: opts.until ?? null,
    }),
};

/** Compact cumulative duration: "1h 23m", "42m", "45s". */
export const formatDuration = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
};

/** Live ticking duration: H:MM:SS, or M:SS under an hour. Tabular-nums so the
 *  width stays stable as seconds roll over. */
export const formatLiveDuration = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
};

/** Today's date as ISO YYYY-MM-DD in *local* time. The Rust backend timestamps
 *  actions with local chrono, so journal date ranges must be local too — the
 *  UTC-based `todayStr()` below would shift the day boundary near midnight. */
export const localDateStr = (d: Date = new Date()) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

/** Add `days` to today (negative = past), returning local ISO YYYY-MM-DD. */
export const localDateStrOffset = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localDateStr(d);
};

export const todayStr = () => new Date().toISOString().slice(0, 10);

/** Format an ISO YYYY-MM-DD reminder as a short, scannable chip (→ Aug 12). */
export const formatReminder = (iso: string): string => {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/** Deterministic, well-spaced color per project so the eye can group items at a
 *  glance. Hash the id → hue; fixed S/L tuned for legibility on the dark bg. */
export const projectColor = (id: string): string => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 65% 68%)`;
};

/**
 * Detect a `#tag` in item text and resolve it to a Project by name — so typing
 * "fix bug #day" links the item to the "dayapp" project without opening the #
 * popover. This is an input shortcut for the existing Projects axis, *not* a
 * separate tag entity (see AGENTS.md "What NOT to add").
 *
 * Matching is case-insensitive: an exact name match wins; otherwise a *unique*
 * name prefix links (so "#day" → "dayapp" only if no other project name starts
 * with "day"). Ambiguous or unmatched tags are left in the text verbatim.
 *
 * Only the first resolvable tag is used — an item carries a single project —
 * and that tag is stripped from the returned text. Returns `projectId: null`
 * when nothing resolved; callers decide whether null means "no project" (on
 * create) or "leave the existing assignment alone" (on edit).
 */
export function parseProjectTag(
  text: string,
  projects: Project[],
): { text: string; projectId: string | null } {
  if (projects.length === 0) return { text, projectId: null };
  // A tag is `#` at a word boundary (start or after whitespace) followed by
  // word chars / hyphens — so "foo#bar" mid-word is not treated as a tag.
  const tagRe = /(?:^|\s)#([\w-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text)) !== null) {
    const project = resolveProjectByName(m[1], projects);
    if (project) {
      const cleaned = text.slice(0, m.index) + text.slice(m.index + m[0].length);
      const normalized = cleaned.replace(/\s+/g, " ").trim();
      // Only strip the tag when something readable remains — a bare "#day"
      // shouldn't create an empty row. Otherwise keep the tag visible so the
      // input is never lost, and still assign the project.
      return { text: normalized || text.trim(), projectId: project.id };
    }
  }
  return { text, projectId: null };
}

/** Exact (case-insensitive) name match wins; otherwise a unique prefix match.
 *  No match, or an ambiguous prefix (≥2 projects), resolves to null. */
function resolveProjectByName(tag: string, projects: Project[]): Project | null {
  const lower = tag.toLowerCase();
  const exact = projects.find((p) => p.name.toLowerCase() === lower);
  if (exact) return exact;
  const prefixes = projects.filter((p) => p.name.toLowerCase().startsWith(lower));
  return prefixes.length === 1 ? prefixes[0] : null;
}

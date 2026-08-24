// Typed wrapper over the Tauri invoke bridge.
// Every Rust #[tauri::command] in src-tauri/src/lib.rs has a mirror here.

import { invoke } from "@tauri-apps/api/core";

export type Section = "today" | "daily" | "backlog";
export type Status = "active" | "done";

/** Hide duration. `forever` hides until manually unhidden; the rest auto-restore
 *  at the start of the named period's end date (day = tomorrow, etc.). */
export type HideDuration = "forever" | "day" | "week" | "month";

/** How the list queries treat hidden rows — the three ⌘P visibility modes:
 *  `exclude` (regular view), `include` (Show All — hidden inline), `only`
 *  (Show Hidden Only). Mirrors `HiddenFilter` in src-tauri/src/db.rs. */
export type HiddenFilter = "exclude" | "include" | "only";

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
  priority: 1 | 2 | 3 | null;
  /** Delegation axis: true = fully delegable to an AI agent (the `@` token).
   *  Housekeeping like priority — not logged. */
  assignedToAgent: boolean;
  /** Free-form spec under the one-line title; for agent rows, the prompt an
   *  autonomous session executes. Content like notes — not logged. */
  details: string;
}

export interface Action {
  id: number;
  /** Set on item rows; null on goal rows (and vice versa for goalId). */
  itemId: string | null;
  goalId: string | null;
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
  listItems: (section: Section, includeDone = false, hidden: HiddenFilter = "exclude") =>
    invoke<Item[]>("list_items", { section, includeDone, hidden }),
  createItem: (text: string, section: Section) =>
    invoke<Item>("create_item", { text, section }),
  editItem: (id: string, text: string) =>
    invoke<void>("edit_item", { id, text }),
  completeItem: (id: string) => invoke<void>("complete_item", { id }),
  uncompleteItem: (id: string) => invoke<void>("uncomplete_item", { id }),
  moveItem: (id: string, toSection: Section, newIndex: number) =>
    invoke<void>("move_item", { id, toSection, newIndex }),
  deleteItem: (id: string) => invoke<void>("delete_item", { id }),
  hideItem: (id: string, duration: HideDuration) =>
    invoke<void>("hide_item", { id, duration }),
  unhideItem: (id: string) => invoke<void>("unhide_item", { id }),
  setItemProject: (id: string, projectId: string | null) =>
    invoke<void>("set_item_project", { id, projectId }),
  setReminder: (id: string, remindAt: string | null) =>
    invoke<void>("set_reminder", { id, remindAt }),
  setItemPriority: (id: string, priority: 1 | 2 | 3 | null) =>
    invoke<void>("set_item_priority", { id, priority }),
  setItemAgent: (id: string, assigned: boolean) =>
    invoke<void>("set_item_agent", { id, assigned }),
  setItemDetails: (id: string, details: string) =>
    invoke<void>("set_item_details", { id, details }),
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

// ---- Goals ----------------------------------------------------------------
// The identity layer above the task sections: statements of direction at three
// horizons — short (months, completable), long (years, completable), timeless
// (a direction, never achieved). Like items, goals are state + logged
// activity: every create/achieve/unachieve/edit/delete appends to `actions`
// (goal_* values — see src-tauri/src/goals.rs); only the project link is
// housekeeping, unlogged.

export const GOAL_HORIZONS = ["short", "long", "timeless"] as const;
export type GoalHorizon = (typeof GOAL_HORIZONS)[number];

export interface Goal {
  id: string;
  text: string;
  horizon: GoalHorizon;
  status: "active" | "achieved";
  projectId: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  achievedAt: string | null;
}

export const goalsApi = {
  list: () => invoke<Goal[]>("list_goals"),
  create: (text: string, horizon: GoalHorizon, projectId: string | null) =>
    invoke<Goal>("create_goal", { text, horizon, projectId }),
  edit: (id: string, text: string, horizon: GoalHorizon | null) =>
    invoke<void>("edit_goal", { id, text, horizon }),
  setProject: (id: string, projectId: string | null) =>
    invoke<void>("set_goal_project", { id, projectId }),
  achieve: (id: string) => invoke<void>("achieve_goal", { id }),
  unachieve: (id: string) => invoke<void>("unachieve_goal", { id }),
  delete: (id: string) => invoke<void>("delete_goal", { id }),
};

/** The goals capture/edit parser: a leading horizon word (short / long /
 *  timeless, case-insensitive) picks the tier and is stripped, then the normal
 *  `#tag` project rules apply to the remainder ("long better entrepreneur
 *  #hustle" → long horizon, "better entrepreneur", hustle project). When the
 *  word is the whole input it stays literal so the input is never lost — the
 *  same rule stripTag applies. `horizon` is null when no token was present;
 *  callers decide whether that means "short" (on create) or "leave the tier
 *  alone" (on edit), mirroring parseItemTags. */
export function parseGoalText(
  text: string,
  projects: Project[],
): { text: string; horizon: GoalHorizon | null; projectId: string | null; createProjectName?: string } {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/);
  const first = words[0]?.toLowerCase() ?? "";
  if (words.length > 1 && (GOAL_HORIZONS as readonly string[]).includes(first)) {
    const project = parseProjectTag(words.slice(1).join(" "), projects);
    return { horizon: first as GoalHorizon, ...project };
  }
  const project = parseProjectTag(trimmed, projects);
  return { horizon: null, ...project };
}

/** Month-granular display for a goal's achievedAt timestamp ("Aug 2026") —
 *  goal achievements are season-scale events, not day-scale rows. */
export const formatGoalAchieved = (iso: string): string => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
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

// ---- Mobile sync ----------------------------------------------------------
// GitHub-file transport for the Android client (see src-tauri/src/sync.rs).
// The Mac is the single writer: deploy pushes tasks.json; pull drains the
// phone's captures.json inbox for ingestion through the normal create path.

export interface SyncConfig {
  repo: string;           // "owner/name" of the private data repo
  branch: string;         // "main"
  token: string | null;   // PAT; null → the backend falls back to `gh auth token`
}

export interface SyncStatus {
  configured: boolean;
  repo: string;
  branch: string;
  lastPushAt: string | null;
  lastPullAt: string | null;
}

export interface SyncCapture {
  id: string;
  text: string;
  section: "today" | "backlog";
  at: string;
}

export const syncApi = {
  getConfig: () => invoke<SyncConfig>("sync_get_config"),
  setConfig: (config: SyncConfig) => invoke<void>("sync_set_config", { config }),
  /** Force-push the export; resolves with a human-readable outcome. */
  deploy: (force: boolean) => invoke<string>("sync_deploy", { force }),
  pull: () => invoke<SyncCapture[]>("sync_pull_captures"),
  markIngested: (ids: string[]) => invoke<void>("sync_mark_ingested", { ids }),
  status: () => invoke<SyncStatus>("sync_status"),
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

/** The `hidden_until` date a hide duration maps to (local ISO YYYY-MM-DD), or
 *  null for forever. Mirrors `hidden_until_for` in db.rs — used for optimistic
 *  updates so a just-hidden row's expiry chip is right immediately, without
 *  waiting for the next refresh to reconcile. */
export const hideExpiry = (duration: HideDuration): string | null => {
  if (duration === "forever") return null;
  const d = new Date();
  if (duration === "day") d.setDate(d.getDate() + 1);
  else if (duration === "week") d.setDate(d.getDate() + 7);
  else {
    // Calendar month with the day clamped to the target month's length,
    // matching chrono's checked_add_months (Jan 31 + 1 month = Feb 28/29).
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  }
  return localDateStr(d);
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

/** The combined capture/edit text parser: resolves `#tag` → Project, `!1..3` →
 *  priority, and a bare `@` → agent assignment, stripping all three from the
 *  returned text. The token kinds are independent and composable in any order
 *  ("fix bug #acme !2 @", "fix bug @ !2 #acme", or any alone) — agent and
 *  priority tokens are stripped first so a trailing `#tag` still satisfies the
 *  project-create rule on the remaining text. When nothing resolves, the
 *  fields are null/false-side and callers decide whether that means "not set"
 *  (on create) or "leave the existing value alone" (on edit).
 *
 *  See `parseProjectTag` for the project resolution rules; the priority rule
 *  is: any `!0..3` at a word boundary, the LAST one wins, all are stripped
 *  (`!0` means "clear", only meaningful on edit). The agent rule is the same
 *  shape: a standalone `@` assigns, `@0` is the explicit clear, `@word` stays
 *  literal (so "ping @bob" is never eaten); last token wins.
 */
export function parseItemTags(
  text: string,
  projects: Project[],
): { text: string; projectId: string | null; createProjectName?: string; priority: 0 | 1 | 2 | 3 | null; agent: boolean | null } {
  const noAgent = parseAgentToken(text);
  const stripped = parsePriorityTag(noAgent.text);
  const project = parseProjectTag(stripped.text, projects);
  return { ...project, priority: stripped.priority, agent: noAgent.agent };
}

/** Extract & strip the delegation tokens: a standalone `@` (assign to the AI
 *  agent) or `@0` (clear the assignment), both at word boundaries. `@1` also
 *  assigns, mirroring the `!N` shape. Like the priority parser, a bare token
 *  that would empty the row keeps the text intact so the input is never lost —
 *  the assignment still applies. */
function parseAgentToken(text: string): { text: string; agent: boolean | null } {
  const re = /(?:^|\s)@([01]?)(?=\s|$)/g;
  const spans: { start: number; end: number; on: boolean }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    spans.push({
      start: m.index,
      end: m.index + m[0].length,
      on: m[1] !== "0",
    });
  }
  if (spans.length === 0) return { text, agent: null };
  const agent = spans[spans.length - 1].on;
  let out = "";
  let pos = 0;
  for (const s of spans) {
    out += text.slice(pos, s.start);
    pos = s.end;
  }
  out += text.slice(pos);
  const normalized = out.replace(/\s+/g, " ").trim();
  return { text: normalized || text.trim(), agent };
}

/** Extract & strip `!0..3` tokens (word-boundary `!` + digit, so "wow!!" and
 *  "foo!bar" stay literal). The last token's level wins; 0 is the explicit
 *  clear. Like stripTag, a bare token that would empty the row keeps the text
 *  intact so the input is never lost — the priority still applies. */
function parsePriorityTag(text: string): { text: string; priority: 0 | 1 | 2 | 3 | null } {
  const re = /(?:^|\s)!([0-3])(?=\s|$)/g;
  const spans: { start: number; end: number; level: 0 | 1 | 2 | 3 }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    spans.push({
      start: m.index,
      end: m.index + m[0].length,
      level: Number(m[1]) as 0 | 1 | 2 | 3,
    });
  }
  if (spans.length === 0) return { text, priority: null };
  const priority = spans[spans.length - 1].level;
  let out = "";
  let pos = 0;
  for (const s of spans) {
    out += text.slice(pos, s.start);
    pos = s.end;
  }
  out += text.slice(pos);
  const normalized = out.replace(/\s+/g, " ").trim();
  return { text: normalized || text.trim(), priority };
}

/**
 * Detect a `#tag` in item text and resolve it to a Project — so typing
 * "fix bug #day" links the item to the "dayapp" project without opening the #
 * popover. This is an input shortcut for the existing Projects axis, *not* a
 * separate tag entity (see AGENTS.md "What NOT to add"). Callers go through
 * `parseItemTags`, which also handles `!N` priority tokens.
 *
 * Two passes, in order:
 *  1. **Existing match** — case-insensitive exact name win, else a *unique*
 *     name prefix (so "#day" → "dayapp" only if no other project starts with
 *     "day"). The first resolvable tag wins; an item carries a single project.
 *  2. **Create** — if *no* tag matched an existing project, the LAST tag may
 *     create a brand-new project — but only when it ends the text with nothing
 *     after it (e.g. "fix bug #acme" bootstraps an "acme" project; "fix bug
 *     #acme notes" does not). A bare "#acme" that would empty the row keeps the
 *     text intact so the input is never lost.
 *
 * Whichever path wins, the winning tag is stripped from the returned text.
 * `createProjectName` is mutually exclusive with `projectId`; callers create
 * the project and assign it. When nothing resolved, `projectId` is null and
 * callers decide whether that means "no project" (on create) or "leave the
 * existing assignment alone" (on edit).
 */
export function parseProjectTag(
  text: string,
  projects: Project[],
): { text: string; projectId: string | null; createProjectName?: string } {
  // A tag is `#` at a word boundary (start or after whitespace) followed by
  // word chars / hyphens — so "foo#bar" mid-word is not treated as a tag.
  const tagRe = /(?:^|\s)#([\w-]+)/g;
  const tags: { index: number; fullLen: number; name: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text)) !== null) {
    tags.push({ index: m.index, fullLen: m[0].length, name: m[1] });
  }

  // 1) Existing project: first resolvable tag wins. Strip it from the text.
  for (const t of tags) {
    const project = resolveProjectByName(t.name, projects);
    if (project) return stripTag(text, t.index, t.fullLen, project.id);
  }

  // 2) No existing match: create a project from the last tag, but only when it
  //    sits at the very end of the text (nothing but whitespace after it).
  if (tags.length > 0) {
    const last = tags[tags.length - 1];
    const end = last.index + last.fullLen;
    if (text.slice(end).trim() === "") {
      const cleaned = stripTag(text, last.index, last.fullLen, null);
      return { ...cleaned, createProjectName: last.name };
    }
  }

  return { text, projectId: null };
}

/** Slice the tag out of `text` and normalise whitespace. Only strip when
 *  something readable remains — a bare "#day" shouldn't produce an empty row;
 *  in that case the tag is kept visible so the input is never lost. */
function stripTag(
  text: string,
  index: number,
  fullLen: number,
  projectId: string | null,
): { text: string; projectId: string | null } {
  const cleaned = text.slice(0, index) + text.slice(index + fullLen);
  const normalized = cleaned.replace(/\s+/g, " ").trim();
  return { text: normalized || text.trim(), projectId };
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

// ---- The note metadata footer ----------------------------------------------
//
// A note body may end with: a blank line, then a final line holding ONLY `!1..3`
// and/or `#tag` tokens — the note-body counterpart of the items' end-of-line
// tokens (bodies are prose, so the tokens get their own trailing line instead).
// The footer is stored verbatim and the backend derives priority/project_id
// from it on every save; these helpers are the TS mirror of that grammar
// (parse_note_footer in notes.rs) for the surfaces that render or produce
// bodies. Strict shape: any prose on the line makes it just text, so a
// markdown-ish "# Heading" or a stray "wow!!" never parses.

/** Split a body into its footer metadata and the prose above it. `body` has the
 *  footer (and its separating blank line) removed — the source for the
 *  collapsed preview line and .txt export name. With no valid footer, `body` is
 *  the input unchanged and both metadata fields are null. */
export function splitNoteFooter(body: string): { body: string; priority: 1 | 2 | 3 | null; tag: string | null } {
  const lines = body.split("\n");
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) { last = i; break; }
  }
  // The footer: the last non-empty line, not the body's first, with a blank
  // line directly above it.
  if (last > 0 && !lines[last - 1].trim()) {
    let priority: 1 | 2 | 3 | null = null;
    let tag: string | null = null;
    let ok = true;
    for (const tok of lines[last].trim().split(/\s+/)) {
      if (/^![1-3]$/.test(tok)) priority = Number(tok[1]) as 1 | 2 | 3;      // last wins
      else if (/^#[\w-]+$/.test(tok)) tag = tok.slice(1);                     // last wins
      else { ok = false; break; }
    }
    if (ok && (priority !== null || tag !== null)) {
      return { body: lines.slice(0, last - 1).join("\n").trimEnd(), priority, tag };
    }
  }
  return { body, priority: null, tag: null };
}

/** Serialize a split footer back to its canonical line form ("!2 #growth"). */
export const noteFooterText = (s: { priority: 1 | 2 | 3 | null; tag: string | null }): string =>
  [s.priority ? `!${s.priority}` : "", s.tag ? `#${s.tag}` : ""].filter(Boolean).join(" ");

/** Re-join a prose body with its footer line ("body\n\n!2 #tag"); with no footer
 *  tokens the body passes through verbatim. The inverse of splitNoteFooter for
 *  the save path (the two-field editor in Notes.tsx joins on every save). */
export const joinNoteBody = (body: string, footer: string): string => {
  const f = footer.trim();
  return f ? `${body.replace(/\s+$/, "")}\n\n${f}` : body;
};

/** Note-capture normalization: trailing `!N`/`#tag` tokens on the capture line
 *  (task muscle memory — they sit at the end there too) are rewritten as the
 *  note's metadata footer: blank line + token line appended to the body. `@`
 *  tokens are deliberately not parsed — notes have no delegation axis, and
 *  `@word` stays literal. A line that is nothing but tokens keeps verbatim (the
 *  input is never lost); at most one of each kind travels to the footer (second
 *  occurrence ends the trailing run). */
export function normalizeNoteCapture(text: string): string {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/);
  let i = words.length;
  let prio: string | null = null;
  let tag: string | null = null;
  while (i > 0) {
    const w = words[i - 1];
    if (prio === null && /^![1-3]$/.test(w)) { prio = w; i--; continue; }
    if (tag === null && /^#[\w-]+$/.test(w)) { tag = w; i--; continue; }
    break;
  }
  if (i === words.length) return trimmed; // no trailing tokens — body as typed
  const rest = words.slice(0, i).join(" ").trim();
  if (!rest) return trimmed;              // tokens only — keep the line literal
  return `${rest}\n\n${[prio, tag].filter(Boolean).join(" ")}`;
}

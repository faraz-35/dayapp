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

// ---- Entries (the ##j/##q typed capture) -----------------------------------
// The notes bus's other destination: a leading `##j`/`##q` token in the Notes
// capture bar routes the line to the `entries` table instead of creating a
// note — a journal entry (rendered by the Journal view) or a quote (rendered
// by the rotating line under the header). Content like notes: never logged to
// `actions`. See src-tauri/src/journal.rs.

export type EntryKind = "journal" | "quote";

export interface Entry {
  id: string;
  kind: EntryKind;
  text: string;
  /** ISO `YYYY-MM-DD` — the local day at capture; edits never move it. */
  day: string;
  createdAt: string;
}

export const entriesApi = {
  list: () => invoke<Entry[]>("list_entries"),
  add: (kind: EntryKind, text: string) => invoke<Entry>("add_entry", { kind, text }),
  update: (id: string, text: string) => invoke<void>("update_entry", { id, text }),
  delete: (id: string) => invoke<void>("delete_entry", { id }),
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

// ---- Journal dashboard ------------------------------------------------------
// The Journal view's synthesized summary layer over `actions` (see
// src-tauri/src/dashboard.rs): per-day done/missed across the range, a
// completion heatmap window, and project/priority splits of completions.
// Pure queries over the log — the same spine as everything else. No time
// stats: sessions stay a dimension the Journal layers in, not dashboard
// material.

/** The analytics page's scope filter: which projects / priority tiers the
 * whole dashboard derives over (stats, heatmap, splits, ledger, day detail).
 * Each axis is null = unfiltered; a null entry *inside* a selection is the
 * "no project" / "unmarked" bucket. OR within an axis, AND across the two.
 * Reads the same write-time snapshots the splits do, so filtered history
 * survives reassignment and deletion. Tracked time deliberately doesn't
 * follow (sessions carry no axes — see dashboard.rs). */
export interface DashboardFilter {
  projects: (string | null)[] | null;
  priorities: (number | null)[] | null;
}

/** The unfiltered scope — what the CLI and pre-filter callers see. */
export const NO_SCOPE: DashboardFilter = { projects: null, priorities: null };

export interface DayStat {
  date: string; // YYYY-MM-DD
  done: number;
  dailyMissed: number;
  todayMissed: number;
}

export interface HeatDay {
  date: string; // YYYY-MM-DD
  done: number; // nonzero — absent days are 0
}

/** One project's slice of the range's completions; `name: null` is the "no
 *  project" bucket. Current projects zero-fill so the whole roster shows. */
export interface ProjectCount {
  name: string | null;
  count: number;
}

/** One priority tier's slice; `tier: null` is the unmarked bucket. Always
 *  four rows, P1 → P3 → unmarked. */
export interface TierCount {
  tier: 1 | 2 | 3 | null;
  count: number;
}

export interface DashboardStats {
  days: DayStat[];
  heatmap: HeatDay[];
  projects: ProjectCount[];
  priorities: TierCount[];
  totals: {
    done: number;
    dailyMissed: number;
    todayMissed: number;
    /** Consecutive days with ≥1 completion, counting back from today; a live
     *  today with nothing yet doesn't break it. */
    streak: number;
  };
}

export const journalApi = {
  dashboard: (
    opts: { since?: string; until?: string; filter?: DashboardFilter } = {},
  ) =>
    invoke<DashboardStats>("journal_dashboard", {
      since: opts.since ?? null,
      until: opts.until ?? null,
      filter: opts.filter ?? null,
    }),
  /** One day at task level — what the ledger's expanded row renders, scoped
   * by the same filter as the dashboard. */
  dayDetail: (date: string, filter: DashboardFilter = NO_SCOPE) =>
    invoke<DayDetail>("journal_day_detail", { date, filter }),
};

/** A task completed on the picked day (HH:MM of its effective completion,
 *  plus the day's tracked seconds for it). */
export interface DoneTaskDetail {
  itemId: string;
  time: string;
  text: string;
  project: string | null;
  priority: 1 | 2 | 3 | null;
  secs: number;
}

/** A today task that fell to Backlog that day. */
export interface FellTaskDetail {
  time: string;
  text: string;
}

export interface DayDetail {
  date: string;
  done: DoneTaskDetail[];
  fell: FellTaskDetail[];
  /** Texts of habits the day ended without (empty for the live today). */
  dailyMissed: string[];
}

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

// ---- Backups ------------------------------------------------------------------
// Point-in-time snapshots of the real db (⌘P → Backups: Capture Now /
// dayapp --backup). Capture-only — no restore surface yet; files land in
// backups/ beside the db. Gated in demo mode like mobile sync.

export const backupApi = {
  /** Captures a snapshot and resolves with the new file's absolute path. */
  capture: () => invoke<string>("capture_backup"),
  reveal: () => invoke<void>("reveal_backups"),
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

// ---- Token scanner ------------------------------------------------------------
//
// One matcher for every typed token (`##j`/`##q` routes, `#tag` projects,
// `!N` priority, `@` agent), shared by the capture parsers below and the
// capture fields' syntax coloring (TokenField.tsx). Single source on purpose:
// what colors as a token while you type is exactly what processes at Enter —
// the two can never drift apart.

export type TokenKind = "entry" | "project" | "priority" | "agent";

/** A matched token. `start`/`end` span the sigil through the token's last
 *  char (the word-boundary space before it stays plain text); `value` is the
 *  captured payload — the route letter, project name, digit, or "" for a
 *  bare `@`. */
export interface TokenSpan {
  kind: TokenKind;
  start: number;
  end: number;
  value: string;
}

// A sigil token: the sigil at a word boundary (start of text or after one
// whitespace char — so "foo#bar" and "wow!!" stay literal), then its payload.
const PROJECT_RE = /(?:^|\s)#([\w-]+)/g;
const PRIORITY_RE = /(?:^|\s)!([0-3])(?=\s|$)/g;
const AGENT_RE = /(?:^|\s)@([01]?)(?=\s|$)/g;
// The notes-bus route: a leading ##j/##q only (lookahead, so the token itself
// is exactly the three chars and the text after it starts at a boundary).
const ENTRY_RE = /^##([jq])(?=\s|$)/;
// The notes' project-clear twin of !0 — stripped ahead of parseProjectTag so a
// project literally named "0" can never resolve.
const NOTE_CLEAR_RE = /(?:^|\s)#0(?=\s|$)/g;

interface SigilSpan {
  start: number;
  end: number;
  value: string;
}

// Every match of a sigil regex, spans covering just the token. `^` only
// matches at index 0, so any other match began with its one boundary space.
function matchSigil(text: string, re: RegExp): SigilSpan[] {
  const out: SigilSpan[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({
      start: m.index + (m.index === 0 ? 0 : 1),
      end: m.index + m[0].length,
      value: m[1] ?? "",
    });
  }
  return out;
}

/** Slice every span out and normalise whitespace. The empty-result guard (the
 *  "input is never lost" rule) belongs to callers. */
function stripSpans(text: string, spans: SigilSpan[]): string {
  let out = "";
  let pos = 0;
  for (const s of spans) {
    out += text.slice(pos, s.start);
    pos = s.end;
  }
  out += text.slice(pos);
  return out.replace(/\s+/g, " ").trim();
}

/** Every token in the line, for the capture fields' syntax coloring. `kinds`
 *  picks the surface's grammar — the section captures carry `@`, the notes
 *  bar doesn't, only the two bus surfaces (notes + journal captures) route
 *  entries. A routed line is the one exception with a grammar of its own:
 *  past a leading ##j/##q everything is verbatim content — no other token
 *  processes there, so none colors there either. */
export function scanTokens(text: string, kinds: readonly TokenKind[]): TokenSpan[] {
  if (kinds.includes("entry")) {
    const m = text.match(ENTRY_RE);
    if (m) return [{ kind: "entry", start: 0, end: m[0].length, value: m[1] }];
  }
  const out: TokenSpan[] = [];
  const sigils: Array<[TokenKind, RegExp]> = [
    ["project", PROJECT_RE],
    ["priority", PRIORITY_RE],
    ["agent", AGENT_RE],
  ];
  for (const [kind, re] of sigils) {
    if (!kinds.includes(kind)) continue;
    for (const s of matchSigil(text, re)) out.push({ kind, ...s });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Extract & strip the delegation tokens: a standalone `@` (assign to the AI
 *  agent) or `@0` (clear the assignment), both at word boundaries. `@1` also
 *  assigns, mirroring the `!N` shape. Like the priority parser, a bare token
 *  that would empty the row keeps the text intact so the input is never lost —
 *  the assignment still applies. */
function parseAgentToken(text: string): { text: string; agent: boolean | null } {
  const spans = matchSigil(text, AGENT_RE);
  if (spans.length === 0) return { text, agent: null };
  const stripped = stripSpans(text, spans);
  return { text: stripped || text.trim(), agent: spans[spans.length - 1].value !== "0" };
}

/** Extract & strip `!0..3` tokens (word-boundary `!` + digit, so "wow!!" and
 *  "foo!bar" stay literal). The last token's level wins; 0 is the explicit
 *  clear. Like stripTag, a bare token that would empty the row keeps the text
 *  intact so the input is never lost — the priority still applies. */
function parsePriorityTag(text: string): { text: string; priority: 0 | 1 | 2 | 3 | null } {
  const spans = matchSigil(text, PRIORITY_RE);
  if (spans.length === 0) return { text, priority: null };
  const stripped = stripSpans(text, spans);
  return {
    text: stripped || text.trim(),
    priority: Number(spans[spans.length - 1].value) as 0 | 1 | 2 | 3,
  };
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
  const tags = matchSigil(text, PROJECT_RE);

  // 1) Existing project: first resolvable tag wins. Strip it from the text.
  for (const t of tags) {
    const project = resolveProjectByName(t.value, projects);
    if (project) return stripTag(text, t, project.id);
  }

  // 2) No existing match: create a project from the last tag, but only when it
  //    sits at the very end of the text (nothing but whitespace after it).
  if (tags.length > 0) {
    const last = tags[tags.length - 1];
    if (text.slice(last.end).trim() === "") {
      return { ...stripTag(text, last, null), createProjectName: last.value };
    }
  }

  return { text, projectId: null };
}

/** Slice the tag out of `text` and normalise whitespace. Only strip when
 *  something readable remains — a bare "#day" shouldn't produce an empty row;
 *  in that case the tag is kept visible so the input is never lost. */
function stripTag(
  text: string,
  span: SigilSpan,
  projectId: string | null,
): { text: string; projectId: string | null } {
  const cleaned = text.slice(0, span.start) + text.slice(span.end);
  const normalized = cleaned.replace(/\s+/g, " ").trim();
  return { text: normalized || text.trim(), projectId };
}

/** Exact (case-insensitive) name match wins; otherwise a unique prefix match.
 *  No match, or an ambiguous prefix (≥2 projects), resolves to null. */
export function resolveProjectByName(tag: string, projects: Project[]): Project | null {
  const lower = tag.toLowerCase();
  const exact = projects.find((p) => p.name.toLowerCase() === lower);
  if (exact) return exact;
  const prefixes = projects.filter((p) => p.name.toLowerCase().startsWith(lower));
  return prefixes.length === 1 ? prefixes[0] : null;
}

// ---- Note tokens ------------------------------------------------------------
//
// Notes set priority/project with the same token grammar as tasks, generalized
// to multi-line bodies: in the CAPTURE field the tokens sit inline (exactly
// item capture, `@` excepted — notes have no delegation axis and `@word` stays
// literal), and in an existing note you type them on their own final line
// after a blank line ("after all the content"). Tokens are input syntax only —
// caught at capture/blur into the columns, never stored or rendered. No token
// leaves the current values alone (like task edits); `!0` clears the priority
// and `#0` clears the project (tasks' `!0` rule plus its project twin — notes
// have no popover to clear through).

/** Split a body's trailing token line: the last non-empty line, when a blank
 *  line separates it from the prose above and it holds ONLY `!0..3` / `#tag`
 *  tokens. Returns the body without it plus the parsed values — `body` is what
 *  renders/previews/exports; the token fields are what the blur-catch applies.
 *  With no valid footer, `body` is the input unchanged and both fields are
 *  null. Strict shape: any prose on the line makes it just text, so a
 *  markdown-ish "# Heading" or a stray "wow!!" never parses. */
export function splitNoteFooter(body: string): {
  body: string;
  /** 0 = the explicit `!0` clear; null = no priority token on the line. */
  priority: 0 | 1 | 2 | 3 | null;
  tag: string | null;
  /** A `#0` token — the explicit project clear. */
  clearProject: boolean;
} {
  const lines = body.split("\n");
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) { last = i; break; }
  }
  if (last > 0 && !lines[last - 1].trim()) {
    let priority: 0 | 1 | 2 | 3 | null = null;
    let tag: string | null = null;
    let clearProject = false;
    let ok = true;
    for (const tok of lines[last].trim().split(/\s+/)) {
      if (/^![0-3]$/.test(tok)) priority = Number(tok[1]) as 0 | 1 | 2 | 3; // last wins
      else if (tok === "#0") clearProject = true;
      else if (/^#[\w-]+$/.test(tok)) tag = tok.slice(1);                   // last wins
      else { ok = false; break; }
    }
    if (ok && (priority !== null || tag !== null || clearProject)) {
      return { body: lines.slice(0, last - 1).join("\n").trimEnd(), priority, tag, clearProject };
    }
  }
  return { body, priority: null, tag: null, clearProject: false };
}

/** The note capture parser — items' grammar minus the delegation axis: `!0..3`
 *  and `#tag` resolve and strip from the line exactly like task capture
 *  (anywhere in the line, last wins, unmatched trailing tag creates), but a
 *  bare `@` / `@word` stays literal. A `#0` (project clear) is stripped and
 *  ignored — a fresh note has nothing to clear, like `!0` at task capture. */
export function parseNoteCapture(
  text: string,
  projects: Project[],
): { text: string; priority: 0 | 1 | 2 | 3 | null; projectId: string | null; createProjectName?: string } {
  // Strip standalone `#0` tokens first so parseProjectTag can't resolve or
  // create a project literally named "0".
  const noClear = stripNoteClearTags(text);
  const stripped = parsePriorityTag(noClear);
  const project = parseProjectTag(stripped.text, projects);
  return { ...project, priority: stripped.priority };
}

function stripNoteClearTags(text: string): string {
  const spans = matchSigil(text, NOTE_CLEAR_RE);
  if (spans.length === 0) return text;
  return stripSpans(text, spans) || text.trim();
}

/** Resolve a footer/capture `#tag` for notes: the item-tag semantics as a
 *  plain lookup — case-insensitive exact name, else a unique prefix, else
 *  create (the caller creates through App's handleCreateProject so the
 *  projects state stays the single source). */
export function resolveNoteTag(
  tag: string,
  projects: Project[],
): { projectId: string | null; createProjectName?: string } {
  const p = resolveProjectByName(tag, projects);
  return p ? { projectId: p.id } : { projectId: null, createProjectName: tag };
}

// ---- Entry tokens (##j / ##q) ------------------------------------------------
//
// The typed-capture router: a LEADING `##j` / `##q` token in the notes capture
// turns the line into a different kind of content (journal entry / quote) that
// is stored and displayed differently. The reserved `##` prefix can't collide
// with the `#tag` project token (a lone `#` never starts a tag word, so
// `#heading` prose is safe too). Leading position only — mid-line `##j` is
// prose; the text after the token is stored verbatim, tokens never linger in
// content.

/** Parse a capture line's leading `##j`/`##q` route. Null when the line isn't
 *  routed (a normal note); `{ kind, text }` with the token stripped otherwise —
 *  `text` may be empty (a bare token), which the caller treats as a no-op
 *  rather than creating an empty entry. */
export function parseEntryCapture(text: string): { kind: EntryKind; text: string } | null {
  const m = text.match(ENTRY_RE);
  if (!m) return null;
  return { kind: m[1] === "j" ? "journal" : "quote", text: text.slice(m[0].length).trim() };
}

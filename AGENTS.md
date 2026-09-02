# DayApp — Agent Guide

A native macOS "live today list" with auto-journaling. Not a journal app — a focused
daily-action tool whose **timestamped action log** *is* the journal, for free. Also
includes free-form **Notes** (the notepad-replacement surface).

Before touching code, read this whole file. The UI/UX section is **load-bearing** — every
decision in it exists for a reason and must be followed, not relitigated.

---

## Product philosophy

The whole app is built on one insight: **several behaviours that sound like features are
just queries over timestamped state.** No cron, no background jobs.

| Behaviour | How it actually works |
|---|---|
| Daily items reset overnight | `last_completed_date == today` comparison on render. At midnight the comparison just stops being true. |
| Today items fall to Backlog | `run_sweep()` runs on launch (gated by `meta.last_sweep_date`). Idempotent. |
| Completed Today items disappear overnight | The same sweep deletes today rows with `status='done'` dated before today — the completion already lives in `actions`, so no extra log row. `purge_completed_today()` repeats it un-gated on launch for rows a gated-out sweep left behind. |
| Backlog reminders promote to Today | `promote_due_reminders()` runs on launch (un-gated, idempotent): backlog rows with `remind_at <= today` move to `today`. |
| "What I did this week" | `SELECT FROM actions WHERE action='completed'`. Every mutation logs itself. The Analytics view summarizes it; `--journal` prints the raw log. |
| "How long I worked on X" | `SELECT SUM(duration_secs) FROM sessions WHERE item_id=X`. ▶/⏸ write open/close timestamps; the Analytics day ledger totals them per day, `--journal` breaks them down per task. The open session row *is* the active timer — no separate state. |

This is the spine of the product. New features should fit this model (state + a log that
writes itself), not fight it.

---

## Architecture

- **Shell:** Tauri 2 (Rust backend + native macOS window). No Next (it's a server
  framework; wrong fit for Tauri).
- **Frontend:** React 19 + Vite + TypeScript.
- **Store:** SQLite via `rusqlite` with the `bundled` feature (one file, no system SQLite
  dependency, trivially snapshotted).
- **DnD:** `@dnd-kit` (core + sortable + utilities).
- **DB location:** `~/Library/Application Support/com.farazshah.dayapp/dayapp.db`
  (driven by the `identifier` in `tauri.conf.json`); `dayapp-demo.db` sits beside
  it as demo mode's disposable twin (see "Demo mode" under Data model).
- **Mobile (Android APK):** built and shipped 2026-08 — a read-only mirror +
  capture inbox over a private GitHub repo (`faraz-35/dayapp-sync`), not a sync
  engine. The Mac app is the single writer of the database; see "Mobile sync"
  under Data model before touching anything in that area.

- **Launch placement (AeroSpace):** every launch lands the window fullscreened in
  AeroSpace workspace 10 — two halves by necessity. `~/.aerospace.toml`'s
  `on-window-detected` moves the window to workspace 10 (AeroSpace callbacks only
  support layout/move commands); `aerospace_fullscreen` in `lib.rs` setup then asks the
  `aerospace` CLI to fullscreen OUR window (pid-matched from `list-windows`, retried
  while AeroSpace attaches). Idempotent; a silent no-op wherever AeroSpace isn't
  installed.

### Stack rules (do not break these)

- **Rust commands return `Result<T, String>`, not `anyhow::Result`.** `anyhow::Error` is
  not `Serialize`, so Tauri can't pass it across IPC. The `with_db` helper in `lib.rs`
  stringifies errors into `Result<_, String>` for you — always go through it.
- **All SQLite work runs on a blocking thread.** rusqlite is synchronous. The `with_db`
  helper wraps each command in `tauri::async_runtime::spawn_blocking`. Never call `Db`
  methods directly from a command body.
- **One `Mutex<Connection>`.** DayApp is single-user, single-process, low-concurrency.
  No pool dependency needed.
- **Every write to `items` or `goals` is wrapped in a transaction that also appends to
  `actions`.** The log must never drift from the live row.

---

## Data model

Two independent feature areas, deliberately decoupled:

### Items (stateful lists + the journal)

```
items   id, text, section, status, last_completed_date, sort_order, created_at, updated_at,
        hidden, hidden_until, project_id, remind_at, priority, assigned_to_agent, details
actions id, item_id, goal_id, item_text, action, from_section, to_section, from_status, to_status, timestamp
meta    key, value           — currently holds last_sweep_date
```

- `section` ∈ `today` | `daily` | `backlog`
- `status` ∈ `active` | `done` — done Today rows stay in the list (crossed, like
  done-daily) until the day-boundary sweep deletes them; `uncomplete_item` flips one
  back to `active` and logs `uncompleted`. Done Backlog rows leave the list (the
  legacy "complete = vanish" behaviour — only Today asks `list_items` for done rows).
- `last_completed_date` — set on every completion (daily's greyed-reset keys off it;
  today's sweep retirement uses it to keep same-day completions safe).
- `hidden` ∈ `0` | `1` — soft-archive. The list commands take a `HiddenFilter`
  (`exclude | include` — ⌘P → Show/Hide Hidden Tasks; `only` remains in the enum's
  vocabulary but no command uses it since the hidden-only mode was retired) instead of
  always filtering `hidden = 0`; in `include` mode archived rows render inline in
  their sections (dimmed, ◐ expiry chip, ↺/× actions only, not draggable).
  `hidden_until` is NULL
  (forever) or an ISO date cleared by the midnight sweep. Hide/unhide is **not** logged to
  `actions` — it's housekeeping, not activity.
- `project_id` — optional assignment to a `projects` row (housekeeping; **not** logged). Shown
  as a color-coded label on the far right of each item row (deterministic hue per project id).
  Deleting a project nulls the FK (items kept).
- `priority` ∈ `1..3` | NULL — urgency tier, set via a `!1`/`!2`/`!3` token in the capture or
  edit text (`parseItemTags` in `lib.ts` strips it; composable with `#tag` in either order;
  last token wins; no token on edit leaves the value alone; `!0` clears). Housekeeping —
  **not** logged. Shown as signal bars (`▮▮▮` `▮▮▯` `▮▯▯` — filled count = urgency, so
  P1 carries the most visual mass; filled bars use the accent, empty slots a faint track)
  on Today/Daily rows only; Backlog rows are clean. The Backlog is sorted by it (priority
  first, then manual order — DnD reorders within a tier) and every tier group there is
  introduced by a hairline divider labeled with the group's bars (the unmarked group's
  label is the empty track; an entirely unmarked Backlog renders undivided — a lone
  marked tier still labels itself, since the dividers are the tier signal there — derived
  purely from the rendered order in `SectionView.tsx`, so filters that drop tiers drop
  their dividers); Today/Daily stay manual.
- `assigned_to_agent` ∈ `0` | `1` — the delegation axis ("who executes"), set via a bare `@`
  token in the capture or edit text (`parseItemTags` in `lib.ts` strips it; composable with
  `#tag`/`!N` in any order; `@0` clears, no token on edit leaves it alone; `@word` stays
  literal so mentions aren't eaten). Housekeeping — **not** logged. Shown as a small
  monochrome robot badge in the row's metadata (every section, kept on hover); filtered by
  ⌘F `@` (Agent tasks / My tasks — the same picker pattern as `#` projects) and toggled by
  ⌘P → Show/Hide Agent Tasks; `dayapp --list` marks the rows with 🤖 so agent sessions can
  see their queue. Binary by design: marked = fully delegable end to end, unmarked = Faraz's
  own — no "agent drafts, I review" middle tier.
- `details` — free-form body under the one-line title: the task's spec/context, and for
  agent-delegated rows **the prompt an autonomous session executes**. Edited in the GUI via
  the hover button (⋯ when the row has no body, ⌄ once it does — the icon itself signals
  "has details") or digit `5` on the focused row (auto-growing textarea under the
  open row — Notes' debounce/autosave pattern; a sibling of the row, never inside the
  dragged element). Content like notes, not state: edits are housekeeping — **not** logged —
  and the field stays out of the phone export. `dayapp --task <query>` prints the row plus
  its body, so an automation picks from `--list` and reads the spec from `--task`.
- `remind_at` — ISO `YYYY-MM-DD` on which a backlog item auto-promotes to `today`. The
  promotion is logged as a `moved` action (backlog→today) and `remind_at` is cleared so it
  fires once. Date-granular, fires on launch (no cron / no macOS notification). Leaving the
  Backlog by any path clears it too (enforced inside `move_item`: drag, the Backlog's
  send-to-Today button, `--move`) — a reminder's job is pulling the row into Today, done
  once the row has been pulled.
- `actions.action` ∈ `created | completed | uncompleted | moved | edited | deleted | fell_to_backlog |
  goal_created | goal_achieved | goal_unachieved | goal_edited | goal_deleted`
- `actions` rows set exactly one subject: `item_id` on item rows, `goal_id` on goal rows
  (CHECK-enforced). On goal rows the section columns carry the horizon and the status
  columns carry active/achieved, so `--journal` renders both subjects uniformly.
- **`actions.item_text` is snapshotted at write time.** History must survive edits and
  deletions — if it referenced the live row, renaming a task would silently rewrite the
  past.
- **`actions.project` / `actions.priority` snapshot the subject's organising axes at write
  time** (same deletion-proofing as `item_text` — `project` holds the project *name*, not
  an FK, because the projects row may not survive; goal rows snapshot the goal's project
  name and carry no priority). The Analytics view's project/priority splits read these,
  so reassigning a task never rewrites the past. The snapshot lives inside `log_action` /
  `log_goal_action`'s INSERT as a subquery on the live row — which is why `delete_item` /
  `delete_goal` log *before* their DELETE. Rows older than the columns were backfilled once
  from then-current state (best effort; deleted subjects stay unattributed).

### Notes (free-form content — NOT logged)

```
notes   id, body, sort_order, created_at, updated_at, priority, project_id
```

Notes are **content**, not **activity**. They have their own table and are never written
to `actions`. Do not add notes to the journal. The ⬇ export (a .txt through the native
save panel — `save_text_file` in `lib.rs`, no db involvement) and the note-local ⌘F find
are pure reading/export verbs over that content: also never logged (one Rust info line
records a completed export, per the logging convention).

Notes carry the items' priority/project axes through the **same token grammar**, generalized
to multi-line bodies: in the capture field the tokens sit inline (exactly item capture —
parsed and stripped by `parseNoteCapture` in `lib.ts`, `@` excepted because notes have no
delegation axis), and in an existing note you type them on their own final line after a
blank line ("after all the content"). Tokens are **input syntax, never stored or rendered**:
on blur the line is caught (`flushAndCatch` in `Notes.tsx` → `splitNoteFooter`) — stripped
from the body and applied to the columns through `set_note_priority`/`set_note_project`
(frontend-parse + setters, exactly the items' model; `parse_note_footer` survives in
notes.rs only to migrate bodies an earlier footer-storing build wrote). No token leaves the
current values alone (so ordinary edits never wipe metadata); `!0` clears the priority and
`#0` the project — tasks' `!0` rule plus its project twin, since notes have no popover.
The tag resolves with exactly the items' trailing-`#tag` semantics (`resolveNoteTag` in
`lib.ts`: case-insensitive exact, unique prefix, else create through App's
handleCreateProject — so a tag whose project was deleted recreates it on the next catch;
`#0` is the durable unlink). Notes
group by tier exactly like the Backlog (`ORDER BY COALESCE(priority, 99), sort_order` —
P1 → P3 → unmarked, tier dividers labeled with the bars; every marked tier labels
itself even when alone, an entirely unmarked list renders undivided); the
cards carry no bars and no metadata chrome beyond the collapsed card's project label
(right-aligned, the row language). Priority/project on notes are housekeeping —
**not logged** — and stay out of the phone export (mobile is a task mirror).
`dayapp --notes` reconstructs the token line after each body from the columns, so agents
still read the axes off the text.

### Entries (the ##j/##q typed capture — NOT logged)

```
entries  id, kind, text, day, created_at
```

The notes capture bar is the app's **typed capture bus**: a leading `##j` or `##q` token
routes the line away from note creation and into the `entries` table — same input, a
different *kind* of content, stored and displayed differently. The reserved `##` prefix
cannot collide with the `#tag` project token (a lone `#` never starts a tag word).
The **task capture routes the same prefix over destinations**: one input above the
section stack (SectionList) replaced the three per-section capture inputs — a leading
`##t`/`##d`/`##b` sends the line to Today/Daily/Backlog via `parseTaskCapture` in
`lib.ts`, no token = Today (the default working destination), a bare token is a no-op,
and the item grammar (`#tag`/`!N`/`@`) composes after the route. The `nt`/`nd`/`nb`
addresses focus it with the token pre-swapped (the `nj`/`nq` pattern). Routes are
capture-only, like the entry routes: an edit never re-routes a row — the drag and the
↑ promote button are how a row moves.

- `kind` ∈ `journal` (`##j`) | `quote` (`##q`). Parsed by `parseEntryCapture` in `lib.ts`
  (leading position only — mid-line `##j` is prose; a bare token with no text is a no-op),
  routed in `Notes.tsx`'s `handleCapture` ahead of `parseNoteCapture`. The grammar's
  `nj`/`nq` addresses focus the notes capture with the route token pre-swapped-in
  (`focusNav.focusCapture` dispatches `ROUTE_EVENT`; `TokenField` rewrites the value) —
  typing the address IS typing the token.
- `##j` → a **journal entry**: one line of reflection stamped with its day, rendered by the
  **Journal view** (its own page — see UI/UX). The action log stays the journal of *what was
  done*; this table is the journal of *what was thought*.
- `##q` → a **quote**: rendered only by the quote modal (⌘P → Show a Quote) — its one
  surface. For now quotes have **no management surface** (capture-only; no edit/delete
  anywhere in the GUI).
- `day` is the local date at capture; edits never move it (`created_at` keeps the within-day
  order, ULID text order breaking same-second ties). Entries have **no organising axes at
  all** — no priority, project, hide, or sort: just text and its day.
- Entries are **content** (the notes/sessions call): never logged to `actions`, excluded
  from the phone export, no CLI surface (the Journal view is their home). Logic lives in
  `src-tauri/src/journal.rs`; the UI is `src/Journal.tsx` (view) + `src/Quotes.tsx`
  (modal).

### Projects (a second organising axis — NOT logged)

```
projects id, name, sort_order, created_at
```

Projects let each item carry a color-coded label on the far right of its row (deterministic
hue per project, so the eye groups items across sections). Assignment is housekeeping (like
hide) — **never** logged to `actions`. `items.project_id` is the nullable FK (no enforced
cascade; deleting a project runs `UPDATE items SET project_id = NULL` — and the same for
`goals` and `notes`). Notes link through their `#tag` token (see "Notes" above); goals
through the # popover. Logic lives in
`src-tauri/src/projects.rs`; the popover is `src/ProjectMenu.tsx`, and rename/delete are
managed in the ⌘F `#` picker (see "Project filter" under UI/UX guidance).

### Goals (the identity layer — logged like items)

```
goals    id, text, horizon, status, project_id, sort_order, created_at, updated_at, achieved_at
```

Statements of direction at three horizons — the top of the app's timescale stack
(timers = seconds, items = days, goals = months → never). Goals give the daily
list its "why" and are prime agent context. Like items they are **state + logged
activity**: every create/achieve/unachieve/edit/delete appends to `actions`
(`goal_*` values; the horizon rides `from/to_section`, active/achieved rides
`from/to_status`). `--journal` renders them with goal verbs ("set goal",
"achieved goal", …) and a **Goals** filter pill. Not exported to the phone
(mobile is a task mirror).

- `horizon` ∈ `timeless` | `long` | `short` — grouped and displayed in that
  order (constitution → career → now) under hairline dividers labeled with the
  horizon names (the same divider pattern as the Backlog's tiers). Set via a
  leading horizon word in the capture/edit text (`parseGoalText` in `lib.ts`
  strips it, default `short` on capture; no word on edit leaves the tier
  alone); composes with `#tag` project tokens like item capture.
- `status` ∈ `active` | `achieved` — short/long goals carry a checkbox;
  achieving stamps `achieved_at` (month-granular display, e.g. "Aug 2026") and
  moves the row to the dim "Achieved" group at the bottom, where the checkbox
  undoes it. **Timeless goals can never be achieved** — a direction, not a
  destination (`achieve_goal` rejects them); their slot renders ∞ and their
  only exit is × (delete).
- `project_id` — optional link to a `projects` row (housekeeping, **not**
  logged; deleting a project nulls it, same as items).
- The section renders at the very top of the main page, above Notes — the
  identity layer sits over everything; **⌘P → Show/Hide Goals** toggles it
  completely (persisted in localStorage `dayapp-goals-visible`, default on — a
  display preference like zoom). **Show Default View hides it** — the default
  working view is the plain task list. Goals don't take part
  in the item visibility/priority/project filters, and there's no DnD — a calm
  static list.
- Logic lives in `src-tauri/src/goals.rs`; the UI is `src/Goals.tsx`; the CLI
  prints them grouped by horizon via `dayapp --goals`.

### Reminders (scheduled promotion via sweep — logged as `moved`)

`items.remind_at` holds an ISO date. On app launch (`setup`, un-gated, idempotent),
`promote_due_reminders()` moves any backlog item whose `remind_at <= today` to `today`,
clears `remind_at`, and logs a `moved` action. No new action enum — reusing `moved` keeps
the `actions` CHECK constraint untouched. Date-granular and fires only when the app is open
(no background daemon); setting a reminder is **not** logged.

### Mobile sync (GitHub file transport — one writer, no merge)

The Android APK is a **mirror + inbox**, not a peer. A private GitHub repo holds two
files and nothing else: `tasks.json` (the Mac's export; deployed by `sync.rs`) and
`captures.json` (the phone's inbox; drained by the Mac). The Mac app is the **only**
writer of the database — the phone never holds state, so no sync/merge logic exists
anywhere. If mobile ever needs real-time mutation, that's a hosted-API tier, a different
architecture — don't grow this one into it.

- **Deploy** (`sync::deploy`): builds the export in one pass and pushes when its sha256
  differs from `meta.sync_last_push_hash`. A sleeping thread in `lib.rs` setup runs it
  every 60s (it also sees CLI writes — both processes share the db file), and ⌘P
  "Mobile: Deploy Task List Now" force-pushes. The export carries raw dates; the phone
  derives day rollovers with the same render-time comparisons the desktop uses, so a
  stale export still renders correctly. It mirrors the desktop list's row visibility:
  hidden rows are excluded, and so are done Backlog rows (complete = vanish there;
  only Today/Daily done rows travel, for render-time grey-out/retirement — `rowState`
  in `MobileView.tsx` retires a done Backlog row too, so a stale export can't show it
  as active). The gate's hash blanks the volatile `exported_at` stamp — it differs on
  every build, so hashing the raw body would push on every 60s cycle even when nothing
  changed.
- **Capture inbox**: the phone appends `{id, text, section, at}` to `captures.json`.
  `pull_captures` returns entries whose ids aren't in `meta.sync_ingested_ids`; the
  **frontend** ingests them through the normal create path (so `#tag`/`!N` parse) and
  calls `mark_ingested`, which records the ids first (the double-ingest guard, capped
  at 500) and then rewrites the file without them, best-effort. Pull runs on launch,
  every 60s, and via ⌘P.
- **Auth**: `meta.sync_repo` / `sync_branch` / `sync_token`; empty token falls back to
  `gh auth token` (zero-config on a machine with the gh CLI). The phone stores its own
  fine-grained PAT (Contents rw, that repo only) in localStorage. Configure via
  ⌘P → "Mobile: Configure Sync…" (`MobileSyncSettings.tsx`). The APK itself is
  distributed from the **public** `faraz-35/dayapp-mobile` repo's Releases (authless
  download — the binary carries no secrets); keep release uploads signed with the same
  debug keystore so they install as updates.
- Logic lives in `src-tauri/src/sync.rs`; the phone UI is `src/MobileView.tsx`
  (renders when the webview UA is Android — same bundle as desktop).

### Demo mode (a second disposable db, swapped under the connection lock)

⌘P → **Enter/Exit Demo Mode** swaps the app onto `dayapp-demo.db` — a sibling
of the real file — so the app can be tried and shown without touching real
data. The seed is `src-tauri/demo.sql` (embedded via `include_str!`, so it
travels in the binary; git tracks it for reviewable history — never commit the
generated `.db`). All timestamps in it are relative to seed day, so a freshly
seeded demo always shows a live-looking week of journal history.

- **The swap lives under the one connection lock** (`Db::conn` in `db.rs`):
  commands lock it and use whatever `Connection` is inside, so the
  `mem::replace` in `demo.rs` is atomic from any command's point of view and
  no command needs to know demo mode exists. The parked side stays open —
  swap-back is instant, and a real timer left running keeps counting honestly
  across the whole demo session. Entering/exiting runs the launch sweeps
  against the newly-active db (each behaves as if relaunched).
- **Demo mode is session-only.** Every launch opens the real db; the flag
  never persists. The single exception is by design: **first run** (no real db
  exists at launch) opens straight into demo mode as the tour, and "Exit Demo
  Mode" is the on-ramp to the clean, empty real db. Do not add any other
  launch path into demo.
- **Demo data persists** across sessions (no auto-reset — deliberate).
  ⌘P → **Reset Demo Data** (demo mode only) re-runs the seed; because seed
  dates are relative to seed day, a reset also freshens an aged demo. A stale
  demo db sweeps forward on entry exactly like a relaunched real db.
- **Mobile sync is hard-gated in `sync.rs`**: `deploy`/`pull_captures`/
  `mark_ingested` no-op and `sync_set_config` refuses while demo is active
  (deploy re-checks before the PUT too — a toggle can land mid-build). The
  ⌘P mobile entries and the frontend ingest tick hide/skip in demo as the UX
  layer over the same gate. Demo tasks must never reach the phone.
- **The CLI takes `--demo`** (a global modifier, any position): opens/creates
  the demo db directly via `Db::open_demo` — the same seeding path, with the
  real db never opened. The post-write deploy hint stays silent (gated).
- The frontend swaps the masthead to **Live @ Demo** (every view) and re-pulls
  everything on the backend's `demo-mode` event — including the
  self-contained surfaces (Notes/Goals re-fetch via a `reloadEpoch` prop) and
  every id-scoped UI state (selection, focus, filters), since ids from the
  other db don't exist. Logic lives in `src-tauri/src/demo.rs` +
  `src-tauri/demo.sql`.

### CLI (remote access)

The binary doubles as a headless CLI (`--list`, `--task`, `--search`, `--journal`, `--notes`,
`--projects`, `--add`, `--complete`, `--start`, `--move`, `--details`, `--goals`, `--backup`,
`--deploy`,
`--sync-pull-peek`, plus the global `--demo` modifier) for
SSH/zcode sessions — see `cli.rs`. It opens the
same db the GUI holds: WAL + `busy_timeout(5s)` make the two processes safe together,
and the GUI's 60s deploy loop picks up CLI writes. `--add` stores text **raw** (token
parsing lives in the frontend); a remote trigger for `t`-style actions goes through
`--complete`/`--start`, which honour the timer rules (completing stops a running timer).
`--list` marks agent-delegated rows with 🤖 — the agent-context view of the delegation
axis, so a session can pick up its queue — and suffixes each row's project as `#name`,
the correlation axis for goal-linked work: a goal linked to project X spawns tasks
tagged `#X`, and the whole chain (goal → tasks → who executes) reads from the CLI
alone. `--task <query>` prints one row in full including its details body — the prompt
surface for the hourly zcode automation that picks a 🤖 task and works it. `--goals`
is read-only — the agent-context view
of the identity layer, grouped timeless → long → short with achieved last.

The read flags deliberately mirror the GUI's surfaces — what the app renders as panels,
the CLI renders as text — so a remote session can access any information in any format:
`--search` is ⌘F (a plain substring over item text; a leading `#` flips to the project
axis — bare `#` lists projects, `#name` lists that project's rows — and `@agent`/`@my`
flip to the delegation axis), `--journal [today|week|month|all|YYYY-MM-DD]` is the
Analytics view's data plus the raw action log (the dashboard summary block — done/missed
totals, streak, project/priority splits — then actions grouped newest-first by day with
the per-day done/missed verdict, the per-task ⏱ breakdown and day total; the log's
textual home is here, the GUI renders aggregates only; default `today`), `--notes`/`--projects` are their
sections (`--notes` prints tier-ordered — the same ORDER BY the GUI groups from — and
reconstructs each note's `!N #name` token line after the body from the columns, so
priority/project read straight off the text), and the `--hidden` modifier on `--list`/`--notes` is the ⌘P "Show Hidden"
reveal (archived rows marked ◐). `--task` also carries the row's ⏱ cumulative time and
pending reminder. The read flags stay read-only; writes are `--add`/`--complete`/`--start`
plus the two delegation verbs: `--move <query> --to <section>` is the drag, headless — the
row appends to the destination (no drop index over SSH), a same-section move is a no-op,
and it logs `moved` like any section change; `--details <query> <body>` replaces the
details body whole (`""` clears; words after the query join with spaces) — content, not
logged, same as GUI edits. Together they close the delegation loop remotely: claim a 🤖
task by moving it to Today, work it, write the outcome back into the body, complete it.
`--backup` runs the GUI's capture path and prints the new file's path, so a remote session
can snapshot the db and scp it off the machine.
The flags are deliberately ungated (the CLI is Faraz's remote access too) — the
"agents touch only their 🤖 queue" discipline lives in the agent's instructions, not the
binary.

### Timers (per-task time tracking — NOT logged)

```
sessions id, item_id, item_text, started_at, ended_at, duration_secs
```

A **single active timer**: at most one row has `ended_at IS NULL`, and that open row *is*
the running timer — there is no separate "active timer" state anywhere. ▶ opens a row;
⏸ fills `ended_at` + `duration_secs`. Starting a new timer finalizes the previous open
session first (single-timer invariant, enforced in `start_timer`). Like Notes/Projects,
sessions are **measurement (content)**, not item-state transitions, so they are **never**
logged to `actions` — the Analytics view surfaces time as a separate dimension via
`session_time_by_day`, which splits sessions across midnight so daily totals are accurate.

- `item_text` is snapshotted at write time (like `actions.item_text`), so the per-task
  breakdown survives edits and deletions. Sessions deliberately carry **no
  project/priority snapshots**: the analytics scope filter covers actions only, not
  tracked time (Faraz's call, 2026-08-25 — see the Analytics view section).
- The active timer **persists across app restarts** (the open row is the source of truth).
  If the app closes mid-session the elapsed keeps counting honestly on reopen; the header
  chip's × discards the session for the "left it running overnight" case.
- Completing or deleting a running item stops its timer first (the session is kept). The
  rule is enforced **inside `complete_item`/`delete_item`'s transaction** — calling surfaces
  never check, so it holds even when a surface's view of the active timer is stale (a
  session started from the CLI is invisible to an open GUI until its 60s tick re-pulls).
  The retirement sweep (`run_sweep`/`purge_completed_today`) finalizes any orphaned open
  session on the rows it deletes — self-heal for data written before the rule existed.
- Logic lives in `src-tauri/src/timers.rs`; the row control is in `src/components/ItemRow.tsx`,
  the header chip + digit `1` on the focused row in `src/App.tsx`. Live elapsed ticks once a second in the
  frontend; the backend is stateless between ticks (it derives elapsed from `started_at`).

### Backups (point-in-time snapshots — capture-only)

⌘P → Backups: Capture Now (or `dayapp --backup`) snapshots the real db into
`backups/` beside it as `dayapp-YYYYMMDD-HHMMSS.db`. One deliberate capture per file —
nothing runs automatically, and there is deliberately no retention pruning (deleting
backups unprompted is worse than keeping them; the db is small). Mechanism: SQLite's
`VACUUM INTO` through the active connection, written to a per-process temp file then
atomically renamed — so the copy is transactionally consistent even while the GUI holds
the db open in WAL mode with the CLI writing concurrently, and it travels as one
standalone file (no `-wal`/`-shm` siblings), safe to copy/archive anywhere.

- There is **no restore surface** yet: restoring means quitting the app and swapping the
  file by hand.
- Gated in demo mode like mobile sync (`capture` bails; the two ⌘P entries hide) — this
  feature protects the REAL data; a snapshot of the seeded sample db would masquerade as one.
- ⌘P → Backups: Reveal Folder opens the folder in Finder (creating it first).
- Logic lives in `src-tauri/src/backup.rs`; the capture logs one INFO line
  (`backup: captured dayapp-…db (240 KB)`).

---

## Logging

The app logs every meaningful flow internally for debugging. Logs are the first place to
look when something misbehaves — especially the self-update flow, which spans app exit and
a detached helper.

**Where logs go:**
- **Backend (Rust):** `tauri-plugin-log` writes to a rotating file in the app log dir
  (`~/Library/Logs/com.farazshah.dayapp/`) and to stdout (visible in the terminal when
  running `tauri dev`). Use the `log` crate macros (`log::info!`, `log::warn!`, etc.).
- **Frontend (TS):** `src/log.ts` exports a `log` object (`log.info`, `log.warn`, …) that
  prefixes lines with `[dayapp]`. `debug` is gated on `import.meta.env.DEV`, so it's silent
  in production builds.

**What to log (the convention):**
- **Lifecycle events at INFO:** app start/ready, DB open, migrations (`migrate: adding column …`),
  the daily sweep (`sweep: N today item(s) fell to backlog`), the unhide sweep, the reminder
  promotion sweep (`reminders: N backlog item(s) promoted to today`), mobile-sync state
  changes (`sync: deployed tasks.json (N items)`, `sync: configured repo …`, frontend
  `sync: ingesting N mobile capture(s)`). Steady-state "no changes" deploys are silent by
  design; deploy failures log at WARN once per distinct message (the 60s loop must not
  spam the log during an outage).
- **Every external-flow step at INFO:** the `self_update` command logs each phase (starting
  build → build succeeded → spawning swap helper → exiting app). This is the critical path
  to debug update failures.
- **Errors at ERROR:** failed spawns, failed builds, failed IPC. Always include the
  underlying error in the message.
- **Do NOT log routine CRUD.** Per-row create/complete/move is already captured in the
  `actions` table — that's the journal. Logging it again is noise. Log only state transitions
  the user can't otherwise see (sweeps, migrations, the update handoff).

**The dev log (demo-mode interaction trace):** a third stream beside the app log and
`actions`, recording the layer neither knows — the **interaction**: which surface, which
input, what the palette ran. `actions` holds the fact (a task was completed), the app log
holds lifecycle; neither holds that it happened via Enter on a focused row vs a checkbox
click. While recording, every semantic UI interaction appends one JSON line to
`~/Library/Logs/com.farazshah.dayapp/devlog-<YYYYMMDD>-<HHMMSS>.jsonl` —
`{"t":12.43,"ts":"…","kind":"capture.task","detail":{"route":"daily","text":"…"}}` where
`t` is seconds since recording start and `kind` is a dotted family.verb over a closed
vocabulary (capture / focus / edit / complete / timer / drag / popover / palette / search /
view / toggle / quote / analytics / demo / …).

- Recording is **demo-scoped**: it auto-arms when demo mode opens (fresh file per entry, so
  t=0 is the demo's t=0 — the studio pipeline aligns subtitles/cue sheets against it),
  disarms on exit, and ⌘P → `Dev Log: Start/Stop Recording` toggles it mid-session (the
  entries exist in demo mode only). Nothing renders the log — the file is the artifact, for
  agents (`ls -t ~/Library/Logs/com.farazshah.dayapp/devlog-*`) and the studio.
- **Semantic verbs only.** The screensaver's discipline applies: app-driven churn (the 1s
  timer tick, the 60s sweep, the masthead rotation) never traces — DOM churn is not
  attention. Held-key auto-repeat is filtered (free-mode scroll) or deduped (clamped focus
  steps don't re-trace).
- Not the rotating app log, not `actions` — a session-scoped debug artifact, safe to
  delete. The backend (`devlog_append` in lib.rs) is a dumb sink: the frontend
  (`src/devlog.ts`) owns the event vocabulary, batches every 250ms, and `trace()` while not
  recording costs one boolean check — call sites trace unconditionally.
- Text payloads ride `clip()` (160 chars) — the trace is a story, not a store. Notes and
  details **body** edits don't trace (content housekeeping); the caught footer token line
  does. Drag-cancel and focus-miss DO trace (a gesture that did nothing is exactly what
  agent debugging needs to see).

**Reading the update log:** the detached swap helper (`scripts/update.sh --swap-only`) writes
to `~/Library/Logs/com.farazshah.dayapp/update.log`. That's separate from the Rust app log
because the app has already exited by the time the helper runs.

---

## File map

```
dayapp/
├── AGENTS.md                       ← this file
├── README.md                       ← run/build instructions (keep in sync)
├── icon-source.svg                 ← icon master; regenerate others via `npx tauri icon`
├── scripts/
│   └── update.sh                   ← build/swap/relaunch helper (called by in-app updater + npm run update)
├── src/
│   ├── App.tsx                     ← shell only: state, effects, the focus grammar (key handler), header, view switching, timer chip
│   ├── lib.ts                      ← items typed API wrapper + types + date helpers + projectsApi + timersApi + goalsApi/parseGoalText + projectColor/formatReminder/formatDuration
│   ├── notesApi.ts                 ← notes typed API wrapper
│   ├── log.ts                      ← prefixed console logger (webview side)
│   ├── devlog.ts                   ← the demo-mode interaction trace: trace()/clip(), recording lifecycle, 250ms JSONL batching
│   ├── focusNav.ts                 ← the grammar's DOM side: data-kb button dispatch, capture focus, nth note/goal, popover check
│   ├── main.tsx                    ← React entry
│   ├── index.css                   ← the dark theme + all component styles
│   ├── Notes.tsx                   ← self-contained notes component (own state + persistence + ⌘F-in-note find + ⬇ .txt export + token-caught tier groups + the ##j/##q capture router)
│   ├── Goals.tsx                   ← goals: horizon groups + capture + achieve (own state; between Notes and the sections)
│   ├── Journal.tsx                 ← the ##j page: day-grouped entries + capture + inline edit/delete (quotes never render here; self-contained, the Notes/Analytics pattern)
│   ├── Quotes.tsx                  ← the ##q moment: one quote on a dim backdrop, ⌘P-summoned or idle-screensavered (self-contained fetch + pick + linger; `version` prop is the refresh trigger)
│   ├── HideMenu.tsx                ← shared ◐ hide-duration popover (items + notes)
│   ├── ProjectMenu.tsx             ← # assign/clear/create project popover (per item)
│   ├── ReminderMenu.tsx            ← ◷ reminder-date popover (per item); promotion via sweep
│   ├── TokenField.tsx              ← capture/edit field with live token coloring + display forms (##q → quote, !N → bars; transparent text + mirror div + own caret/selection overlay; scanTokens is the one matcher)
│   ├── CommandPalette.tsx          ← ⌘P modal: filter + keyboard nav
│   ├── KeyboardHelp.tsx            ← ⌘P keyboard reference card (the focus grammar, documented)
│   ├── UpdateOverlay.tsx           ← self-update progress/restart/error modal
│   ├── MobileView.tsx              ← Android client: read-only list + capture bar (GitHub fetch, renders when UA is Android)
│   ├── MobileSyncSettings.tsx      ← ⌘P sync-config modal (repo/branch/token + validate-by-deploy)
│   └── components/                 ← feature components, one per file (see "Component responsibilities")
│       ├── SectionList.tsx         ← the ONE task capture (##t/##d/##b routing) + DndContext + drag handlers + maps the 3 sections
│       ├── SectionView.tsx         ← one section (head + sortable items + dropzone; Backlog tier dividers)
│       ├── ItemRow.tsx             ← one item row (▶/⏸ timer control) + inline EditInput + ItemDetailsBody
│       ├── PriorityBars.tsx        ← the tier signal bars (rows, tier dividers, analytics legend, the token display)
│       ├── AnalyticsView.tsx       ← the analytics page: stats + heatmap + splits + day ledger over dashboard.rs (no raw log)
│       └── SearchMenu.tsx          ← ⌘F floating search modal (↑/↓ + Enter to jump; leading # = project filter)
└── src-tauri/
    ├── src/
    │   ├── lib.rs                  ← Tauri commands + setup (first-run demo, sweeps, reminders, logging plugin) + self_update
    │   ├── db.rs                   ← DB layer: items, actions, sweep, hide, reminders, completions + Db struct (conn swap, launch_sweeps)
    │   ├── notes.rs                ← notes DB logic + setters + the stored-footer migration (methods on Db)
    │   ├── journal.rs              ← the ##j/##q typed capture: entries table (journal lines + quotes), day-stamped (methods on Db)
    │   ├── projects.rs             ← projects DB logic + item.project_id assignment (methods on Db)
    │   ├── goals.rs                ← goals DB logic: horizons, achieve/unachieve, project link (methods on Db)
    │   ├── dashboard.rs            ← the analytics derivation: done/missed per day, daily-miss replay, streak, project/priority splits, heatmap window (method on Db)
    │   ├── timers.rs               ← timer sessions: start/stop/discard/totals/per-day (methods on Db)
    │   ├── backup.rs               ← db backups: VACUUM INTO snapshot into backups/ + reveal (--backup; demo-gated)
    │   ├── sync.rs                 ← mobile sync: tasks.json export/deploy + captures.json pull/drain (GitHub Contents API; demo-gated)
    │   ├── demo.rs                 ← demo mode: dayapp-demo.db open/seed + enter/exit/reset swap under the conn lock
    │   ├── cli.rs                  ← headless CLI for SSH/zcode: --list/--task/--search/--journal/--notes/--projects/--add/--complete/--start/--move/--details/--goals/--backup/--deploy/--sync-pull-peek (+ global --demo)
    │   └── main.rs                 ← binary entrypoint (GUI, or cli::run when given flags)
    ├── schema.sql                  ← items + actions + meta + notes + projects + goals + sessions + entries
    ├── demo.sql                    ← the demo seed (relative timestamps; embedded via include_str!, never commit the .db)
    ├── Cargo.toml
    ├── tauri.conf.json             ← window 480x720, identifier, app-only bundle target
    └── capabilities/default.json
```

### Component responsibilities

`App.tsx` is intentionally a thin shell — it owns app-wide **state** (items,
selection, view, overlays), **effects** (load, sweep tick, self-update events),
and **global keyboard handlers** (⌘P, ⌘F, j/k nav). Everything else is delegated
to a focused component in `src/components/`. When adding a feature, pick the
single file it belongs in; do not grow `App.tsx` with new rendering logic.

| File | Owns | Does NOT own |
|---|---|---|
| `App.tsx` | state (incl. the active timer + the one focused thing), effects, the focus grammar key handler, header + timer chip, view switching | rendering of items/rows, DnD logic, view internals |
| `Goals.tsx` | goals state + capture + horizon groups + achieve/edit/delete + project link (self-contained, like `Notes.tsx`) | projects state (App's list is the single source, passed in), item state |
| `Quotes.tsx` | the ##q moment: quote pool fetch, the modal's pick (no consecutive repeats), 45s linger (⌘P summons) / linger-until-input (screensaver opens) | capture (Notes' router adds quotes), the idle watcher (App's), quote management (none exists — capture-only) |
| `Journal.tsx` | the Journal view: entries state, day groups, capture (plain = journal entry), inline edit/delete (self-contained; remounts per view switch; quotes filtered out) | the quote modal (Quotes.tsx), analytics (AnalyticsView) |
| `SectionList.tsx` | the task capture bus (##t/##d/##b route, default Today), `DndContext`, drag start/end, `DragOverlay`, the 3-section map | item state mutations (delegates via `onMoveItem`) |
| `SectionView.tsx` | one section's header + sortable items + dropzone (+ Backlog tier dividers, + the open row's details body) | DnD sensors/handlers, capture (the bus above the stack owns it) |
| `ItemRow.tsx` | one row's render + the ▶/⏸/↑ slot-1 control (timer, or send-to-Today on Backlog rows) + the shared `EditInput`/`PriorityBars`/`ItemDetailsBody` | DnD wiring (from `useSortable` via parent) |
| `AnalyticsView.tsx` | the analytics page: range/dayPick state, dashboard + time fetch, stats/heatmap/splits/day-ledger render | derivation (all in `dashboard.rs`), item state |
| `SearchMenu.tsx` | ⌘F modal state + keyboard nav + jump + `#` project picker | the hit/project lists (passed in from `App`) |

---

## Layout architecture (load-bearing — read before any UI change)

The bugs in this codebase have repeatedly come from layout, not logic. These
rules exist because each one fixes a real regression. Follow them, do not
relitigate them.

### 1. One scroll container

The header is pinned; **a single `.scroll` wrapper scrolls the entire body.**
Never add a second `overflow-y: auto` (or `overflow: auto`) to a child — that
splits the page into independent scroll areas and is exactly the "X scrolls
separately" bug.

```
.app       display:flex column; height:100%; overflow:hidden   ← the shell, never scrolls
  .header  flex-shrink:0                                       ← pinned
  .scroll   flex:1; overflow-y:auto; min-height:0              ← THE ONE scroll container
    Goals / Notes / SectionList / AnalyticsView / Journal ← in-flow, no own scroll
```

`.notes`, `.goals`, `.sections`, `.analytics`, `.journal`, `.hidden-view` must **not** set `overflow`,
`max-height`, `flex: 1`, or `min-height: 0` — they are plain in-flow blocks
inside `.scroll`. If you ever need a region to scroll independently, you are
changing the architecture: update this section and justify why.

### 2. Floating surfaces vs inline chrome

There are two kinds of UI elements, and they must not be mixed:

- **Inline chrome** — capture inputs, section heads, item rows, notes. These
  live in the `.scroll` flow and push content. `position: static`/`relative`.
- **Floating surfaces** — `CommandPalette` (⌘P), `SearchMenu` (⌘F),
  `UpdateOverlay`, the quote modal (`Quotes.tsx`). These are transient overlays:
  `position: fixed; inset: 0` + a dim `rgba(0,0,0,0.4)` backdrop + a centered card,
  mounted at the end of `.app` (not inside `.scroll`). They float *over* content;
  they never push it. (The quote modal deliberately drops the card — the quote
  floats on the bare backdrop; see "Quote modal" under UI/UX.)

**Never mount a floating surface as an inline flex sibling** — it consumes
layout space and "feels inline." The backdrop + centered card is what makes a
modal read as transient. Match `.palette-backdrop`/`.palette` exactly when
adding a new one.

`z-index` ordering: update overlay `110` > quote modal `105` > sync settings `105` >
command palette `100` > search `90` (update highest — an in-flight, non-cancellable
swap outranks everything).

### 3. Positioning discipline

- **No `position: absolute` across a section boundary.** Every absolutely
  positioned element must be contained inside a `position: relative` ancestor
  that owns it (`.hide-menu-wrap`, `.note`, `.search`). An absolute element
  that escapes its section is how rows "land on top of each other."
- **The only `transform` on item rows** is the dnd-kit drag transform
  (`ItemRow.tsx`), which is `null` at rest. Do not add static transforms.
- **No negative margins.** Ever. If you reach for one, the layout model is wrong.

---

## UI/UX guidance (read this carefully)

This is the part the user cares about most. The aesthetic is **Linear-like, dark, minimal,
keyboard-first.** Every choice below is intentional.

### Design principles

1. **Minimal chrome.** Few buttons, few clicks. The content is the UI. If a feature needs
   a visible button to be discoverable, reconsider whether it needs a button or a keybinding.
2. **Reveal actions on hover, not by default.** Icon-only buttons appear on row hover and
   carry a `title` tooltip. Resting state shows only content. This keeps the list scannable.
3. **Keyboard-first, but not keyboard-everything.** DnD exists, but `j`/`k`/`Enter`/`e`/digits
   are the primary path. A feature that's mouse-only is incomplete — but minor actions get
   small hover buttons, not dedicated keybinds. Keybindings are for the frequent core
   (nav, complete, edit, timer); ⌘P is the one door to the rest.
4. **Dense rows, single-line text, ellipsis.** This is a list, not a document.
5. **One accent colour.** `#7b8cff` means "active/selected/completed/done-today." Do not
   introduce a second accent.
6. **Dark, always dark.** No light theme, no `prefers-color-scheme` switching. `color-scheme: dark`.
7. **Identity first, then capture.** Goals — the identity layer — at the very top of
   the content; Notes, the lowest-friction capture surface, right below.
   There is always a ready textarea. (The quote moment is a summoned modal, not
   ambient chrome — see "Quote modal" under UI/UX.)

### Colour tokens (from `index.css` — use these, do not hardcode hex)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0e0f11` | app background, window bg |
| `--bg-elev` | `#16181c` | cards, inputs, elevated surfaces (floating modals, notes) |
| `--bg-hover` | `#1c1f24` | row hover, button hover |
| `--border` | `#23262d` | dividers, input borders |
| `--text` | `#e6e7ea` | primary text |
| `--text-dim` | `#8a8f98` | secondary text |
| `--text-faint` | `#5c6068` | hints, empty states, disabled |
| `--accent` | `#7b8cff` | the ONE accent: done/selected/focus/links |
| `--done` | `#3a3f48` | greyed-out completed daily rows |
| `--danger` | `#e5484d` | delete only |

Typography: `-apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", system-ui, sans-serif`.
Base size **13px**. Section headers are 11px uppercase with `0.08em` letter-spacing.
The serif surfaces are the centered header masthead (the "Live @ Faraz" brand, or
"Analytics"/"Journal" in those views) and the quote modal's line: `ui-serif` (New York)
italic, Didot/Georgia fallbacks (14px for the masthead; the quote scales with the
window — `clamp(19px, 2.5vw, 22px)`, line-height 1.75 — never above 22px,
compact in the 480px frame). The brand
rotates like a station ident — "Faraz" is home, and every 2
minutes it steps out to a random word from `MASTHEAD_THEMES` in `App.tsx`
(growth/money/journey/learn, never the same one twice in a row) and back, each swap
fading in (`title-in`). It is always rendered, even while a timer runs — the timer chip
shows only a pulse + elapsed (task name in its tooltip) so the two coexist on the 480px
window; below 455px of width a media query hides the masthead.

### Spacing & shape

- Rows: `padding: 6px 8px`, `border-radius: 6px`.
- Inner action buttons: 22×22, `border-radius: 4px`.
- Header icon buttons: 24×24, `border-radius: 5px`.
- Transitions: `0.08s–0.12s ease` for hover/focus. Snappy, not slow.
- The header uses `-webkit-app-region: drag` so the title bar drags the window; buttons in
  the header re-set `-webkit-app-region: no-drag`.

### Interaction patterns (existing — match these for new features)

**Token coloring (`TokenField.tsx`):** every capture input AND the token-editing
surfaces color the typed-token grammar live — the `##j`/`##q`/`##t`/`##d`/`##b` routes,
`#tag`, `!N`, and `@` all in the one accent (Faraz's call, 2026-08-29: same purple for
every family — a token reads as "this processes", nothing more). Edit surfaces: task
inline edits (`EditInput` with the full grammar), goal edits (`#tag`), and a note body's
**pending footer line** — `scanNoteFooterTokens` in `lib.ts` is `splitNoteFooter`'s
live twin, coloring exactly the line the blur-catch will strip and apply. Mechanism:
the field's real text is transparent and a mirror div underneath (`.token-mirror`)
renders the same text with colored spans; scroll positions sync because the field
scrolls its content while the mirror clips. The note body uses the same flip
(transparent textarea, visible mirror) with ONE mirror carrying both find marks and
footer tokens. The spans come from `scanTokens` in `lib.ts` — the ONE matcher the
capture parsers also strip through — so coloring can never drift from processing: a
line the surface wouldn't parse (an `@` in the notes bar, a `#tag` in the Journal
capture — plain prose there) stays uncolored, past a notes-bar route (`##j`/`##q`)
nothing colors either (the routed entry line is verbatim content), while the task
capture's `##t`/`##d`/`##b` only routes the destination so its item grammar keeps
coloring past it; inline tokens in a note body never color
(they never process there). Horizon words in the Goals surfaces are prose, not sigil
tokens — they stay plain. Journal entry EDITS stay plain too (entries store
verbatim); the details body has no grammar at all.

**Token display forms (2026-08-29):** a recognized token doesn't just tint — it
converts to what it means in the mirror: `##j`→journal, `##q`→quote, `##t`→today,
`##d`→daily, `##b`→backlog, any `@`-token→agent, and `!0..3`→the priority bars
markup (`!0` the empty track); `#tag` stays verbatim (arbitrary names — nothing to
convert). `tokenDisplay` in `lib.ts` owns the vocabulary beside the matcher, so a
token converts exactly when its surface colors it. Because the word is wider than
the sigil, TokenField's fields hide the native caret/selection (they track the RAW
value and would drift off the visible words) and draw their own over the
SUBSTITUTED layout — Range rects over the mirror's own text nodes, wrap- and
scroll-exact (`.tok-caret`/`.tok-sel-rect`; the real↔display index map rides the
same one-pass mirror model). The caret paints in the value render's own layout
pass (`paint()` in `TokenField.tsx` reads the field's selection at paint time —
never state: a state round-trip lands a frame late, so the caret trailed the
typed text and every keystroke cost a second render; the event listeners only
schedule rAF-deferred pure-DOM paints, honoring the WebKit selectionchange trap's
no-setState-in-dispatch rule), and the single-line mirror tracks the caret for
horizontal scroll instead of copying the input's scrollLeft — the substituted
content is a different width than the raw text, so a copied scrollLeft diverges
from the caret), and every visual→overlay conversion divides by the `<html>`
⌘± zoom: `getBoundingClientRect()` reports visual pixels while the transforms
run inside the zoomed subtree in CSS pixels, so an unconverted delta overshoots
proportionally to its distance from the field's edge — the "caret drifts right
as you type" bug (2026-08-30), invisible at short lengths and growing with
every character. The value is never rewritten — display only; parsers
still strip the raw tokens. The note body's mirror keeps its native caret (no
overlay there), so its footer bars render width-fitted to the raw `!N`
(`baseTextWidth`) and nothing drifts.

**Item rows:**
- Resting: the checkbox circle + text, plus right-aligned metadata. The three identity
  axes — priority signal bars, agent robot badge, project label — render as FIXED COLUMNS
  (priority → agent → project, right-anchored): a row lacking an axis renders its empty
  slot, and Backlog rows (which never carry bars) keep priority's empty slot so the
  columns hold across the section seam. The project column clips every name to 6 letters
  + an ellipsis (`clipProject` in ItemRow — the tooltip carries the full name; only the
  task-row column clips, the ⌘F picker / analytics / collapsed-note label / CLI show
  full names) (2026-08-30). The transient facts (`⏱` cumulative time, reminder chip, hidden chip)
  flow left of the columns. Rows with no metadata at all show only checkbox + text.
  The robot badge shows in every section (there's no agent grouping).
- Hover: row bg → `--bg-hover`; grip (⠿) + the slot-1 verb (▶ timer; on Backlog rows ↑ send
  to Today — the deliberate "pull this into my day" action; timing belongs to Today/Daily,
  where work happens) + project/reminder/hide + delete (×) buttons
  fade in. The robot badge + priority bars + project label stay visible (the row's identity,
  wanted while its actions are on screen); the time / reminder / hidden metadata fades out.
  Checkbox circle
  border → `--accent`. Editing is reached by single-click or the `e` key — there is no explicit
  edit button.
- Timing (the one row whose timer is running): the ⏸ button + live `H:MM:SS` elapsed are
  **always visible** (not hover-gated), in the accent colour, so the active timer is
  identifiable at a glance. The pinned header chip mirrors it (survives scrolling away).
- Done (today): stays in place, greyed + line-through with the checkbox filled accent —
  the same look as done-daily. Enter or a checkbox click toggles it back to active
  (logged as `uncompleted`); the day-boundary sweep deletes the row. A running timer on
  it is stopped first (the session is kept).
- Done (backlog): status flips, row removed from active view, completion logged. A running
  timer on it is stopped first (the session is kept).
- Done-today (daily): stays in place, greyed + line-through, checkbox filled accent. Resets
  automatically when `last_completed_date != today`.
- Edit: double-click text, or hover ✎, or select + `e`. Inline `<input>`, commits on
  Enter/blur, cancels on Escape.
- Details: the spec under the title — a full-width, full-strength writing surface
  under the open row (the hover button — ⋯ when empty, ⌄ once it has a body — or
  digit `5` on the focused row; Escape saves + collapses); zero chrome, the expanded task reads as a small
  document (headline + body) — **primary content, never styled secondary** (no dim
  text, no rail/border, no indent). The body sits on the row's own grid: same
  padding/gap/radius plus mirrored leading slots (a real invisible grip glyph + the
  15px checkbox slot), so its text starts exactly under the row's text and its
  focus tint matches the hovered row's background box. Mirror the markup — never a
  hardcoded indent; the grip glyph has no fixed advance width. For 🤖 rows this is
  the prompt.

**DnD:**
- Drag via the grip handle, not the whole row (so text selection and typing aren't fights).
- `PointerSensor` with a 4px activation distance — prevents accidental drags on click.
- Empty sections are droppable zones (`useDroppable` per section) with a subtle highlight on hover.
- Optimistic reorder in React; `api.moveItem` persists; backend re-indexes sort_order.

**Keyboard — the focus grammar (ViMac-style direct addressing, no mode):**

Exactly one thing is focused app-wide — a task row (`selectedId`), a note, or a
goal (`focusNoteId`/`focusGoalId` in `App.tsx`) — and the digits + `e` act on
whichever it is. Addresses are typed directly; the first key of an address
clears focus (a digit mid-sequence can never fire a button), the grammar is
fixed-length (no timeouts), and an address that lands nowhere is a silent
no-op. Mouse clicks follow the same rule — clicking a row/note/goal focuses it.
The Esc ladder is `open popover → find bar (in a note) → editing → focused → nothing`: an open row popover
(project/reminder/hide) is the top rung — its own document listener closes it,
one press, with the row still focused underneath; each edit surface's own Escape
cancels/flushes and blurs onto the still-focused thing; a global Escape clears
focus entirely, and at that bottom rung digits are
inert — a stray `1-6` can't do anything unseen. That bottom rung ("free mode")
is a reading mode: `j`/`k`/`↑`/`↓` scroll the one `.scroll` container (120px,
smooth — a view-only verb, so it can't act on anything unseen; it works in
every view, Analytics included, where nothing is ever focused). While a row is
focused, `j`/`k` walk the rows and clamp at the ends — they never drop focus;
Esc or a new address is the only way out. The focused thing **shows its hover
buttons** (focus mirrors hover exactly: same tint, same revealed actions, same
metadata fades), so the digits' targets are visible on screen. An open popover
borrows the keyboard from the grammar entirely (`usePopoverKeys`): focus moves
into the menu on open (like digit `5` focusing the details body), ↑/↓ move a
highlight, Enter picks, ProjectMenu routes printable keys into its create
field, and App's handler stands down while `popoverOpen()` — digits/Enter/e
never act on the row underneath a menu the user is inside. ⌘P → Keyboard
Shortcuts is the in-app reference card (`KeyboardHelp.tsx`); the DOM side lives
in `focusNav.ts` (digits dispatch through `data-kb` markers, so a hover button and
its digit share the one real onClick handler).

| Keys | Action |
|---|---|
| `nn` / `nj` / `nq` | the notes capture; `nj`/`nq` pre-route — the leading `##j ` / `##q ` token is swapped in for you |
| `nt` / `nd` / `nb` | the ONE task capture with the destination pre-swapped-in (`##t ` / `##d ` / `##b ` → Today / Daily / Backlog); bare text lands in Today |
| `t1`–`9` / `d1`–`9` | focus a Today / Daily row (visible rows, filter-aware) |
| `b11`–`49` | focus a Backlog row — tier digit first (4 = unprioritized), then row |
| `n11`–`49` | focus a note — tier digit first (4 = unmarked), then row within the tier's visible group (the `b11`–`49` scheme over the notes' tier groups; flat `n1`–`9` retired) |
| `g1`–`9` | focus a goal (DOM order = visual order) |
| `1`–`6` (task) | ▶ timer (Backlog: ↑ send to Today) · # project · ◷ remind · ◐ hide · ⋯ details · × delete — on the focused row (hidden rows: `4` = ↺, `6` = ×) |
| `1`–`4` (note) | ⌃/⌄ expand · ⬇ download .txt · ◐ hide · × delete — ⬇ and × need content (hidden notes: `3` = ↺, `4` = ×) |
| `1`–`3` (goal) | ✓ achieve · # project · × delete |
| `↑`/`↓` + `Enter` (popover open) | move the highlight · pick — # project routes typing to its create field; the date input stays native (Tab reaches it) |
| `j` / `↓` | select next — clamped at the last row; never drops focus |
| `k` / `↑` | select previous — clamped at the first row |
| `j`/`k`/`↑`/`↓` (nothing focused) | scroll the page (120px, smooth) — free mode, every view |
| `Enter` | complete focused task (toggles a crossed Today row back to active) |
| `e` | edit the focused thing (task input / note textarea / goal row) |
| `Esc` | open popover (closes onto the still-focused row) → find bar (in a note) → editing → focused → nothing |
| single-click | task: select + enter edit mode (caret at end, not full-select); note/goal: focus it |
| `⌘P` / `Ctrl+P` | command palette (visibility modes, update, jump to view, keyboard help, …) |
| `⌘F` / `Ctrl+F` | search items — floating modal, ↑/↓ + Enter to jump; a leading `#` flips it to the project filter picker, a leading `@` to the agent/my picker. **While a note's textarea (or its find bar) has focus, ⌘F is note-local instead** — see Notes below |
| `⌘+` / `⌘-` | zoom the whole UI in/out (`⌘0` resets) — CSS `zoom` on `<html>`, persisted in localStorage (`dayapp-zoom`); scales every px dimension together, so the design's proportions hold at any size |

The single-key `t` (timer), `d` (details), and `⌫` (delete) verbs are retired
(2026-08-21) — digits `1`, `5`, and `6` on the focused row do the same jobs.
Do not reintroduce bare single-letter verbs that collide with the address
prefixes `n`/`t`/`d`/`b`/`g`.

**Show/Hide toggles (⌘P):** every layout surface is an independent, persisted toggle
whose label reflects its state — `Goals`, `Notes`, `Today`/`Daily`/`Backlog` sections,
`Hidden Tasks` and `Hidden Notes` (both render hidden entries inline where they live,
dimmed, ↺/× actions), the per-tier `Priority 1/2/3 Tasks` toggles, the notes' own
`Priority 1/2/3 Notes` toggles (independent of the task tiers, like Hidden Notes ≠
Hidden Tasks), and `Agent Tasks` (hides the 🤖-marked rows — the "what's actually mine"
focus view). All persist in localStorage (display preferences, like zoom). The header ◐
button toggles both hidden surfaces at once. There is no hidden-only mode and no separate
archive screen — inline-or-excluded is the whole visibility story.

**Demo mode (⌘P):** `Enter/Exit Demo Mode` swaps the whole database to the disposable
demo twin (see "Demo mode" under Data model); while active, `Reset Demo Data` re-seeds
it and the three Mobile entries hide (the phone belongs to the real db). The masthead
reads `Live @ Demo` in every view — the one indicator, calm by design. Everything else
(sections, grammar, DnD, analytics) runs unchanged on the demo data; that identical-
ness is what makes it a faithful demo. The session's interactions record into the
**dev log** while demo runs — auto-armed, ⌘P → `Dev Log: Start/Stop Recording` to
toggle, nothing on screen (see "The dev log" under Logging).

**Priority visibility (⌘P):** `Show/Hide Priority 1/2/3 Tasks` are three independent toggles —
each hides (or shows) just that tier's rows; unmarked rows are never touched and
toggling one tier leaves the others alone (`hiddenPriorities` in `App.tsx`; DnD indexes
map back to full-list space in `handleMoveItem`). The set persists across launches.
`Show/Hide Priority 1/2/3 Notes` (`hiddenNotePriorities`) is the same pattern over the
notes' tier groups — independent of the task tiers.

**Focus Mode (⌘P):** `Enter/Exit Focus Mode` is a **lens**, not a batch of toggle
mutations — P1 notes only, Today, Daily, and P1 Backlog only (Goals hidden too: the
lens is stricter than the default working view). It composes with the filters/toggles in the
same `displayItems`/Notes pipelines and never mutates them: exiting restores whatever
they were. Persisted (`dayapp-focus-mode`); Show Default View exits it. A capture that
doesn't match the lens (an unmarked note, a non-P1 backlog row) is created but not
shown — the same rule the ⌘F filters follow; capture with a `!1` token to land inside
the lens.

**Project filter (⌘F `#`):** typing a leading `#` in the ⌘F search flips the hit list to the
projects (color dot + name, narrowed by the text after the `#`); picking one narrows the main
list to that project — **items and notes alike** — picking the already-active one clears it
(the same toggle rule as the priority tiers). Same `displayItems` pipeline — it composes
with the priority tier. The picker is also the **project management surface**: each row
reveals ✎ rename and × delete on hover/active, and digits `1`/`2` fire them on the active
row — intercepted in `#` mode only, so a digit there is a verb and never reaches the query
(the project row is a div, not a button, because it hosts the action buttons). Rename is
optimistic in App's projects state (every label renders through the lookup, and rows link by
id, not name, so the new name lands everywhere at once). Delete **unlinks, never deletes
rows** — the backend's `delete_project` nulls `project_id` on items/goals/notes in one
transaction, mirrored optimistically in App — and clears the project filter if it pointed
at the deleted one. Both are housekeeping: not logged.

**Agent filter (⌘F `@`):** the same picker pattern over the delegation axis — a leading `@`
flips the hit list to two fixed entries, `🤖 Agent tasks` and `My tasks`; picking one narrows
the main list to the agent's queue or Faraz's own rows, picking the active one clears it.
Session-only like the project filter; composes with the tiers and the project filter in the
same `displayItems` pipeline.

**Show Default View is the universal reset:** hidden entries excluded, priority tiers
(tasks + notes), project and agent filters cleared, agent tasks shown, focus mode off,
all three sections + Notes shown —
and Goals hidden (the default working view is the plain task list). One command
always restores it.

The keyboard handler **ignores events when an `<input>`/`<textarea>` is focused** so typing
into Notes or edit fields isn't hijacked.

**Notes:**
- Auto-growing `<textarea>` (height driven by JS, `resize: none`, no internal scrollbar).
- Debounced autosave (600ms) + save-on-blur.
- Delete button appears on hover, only when there's content.
- The hover reveal (hide/delete buttons) keys off a JS-tracked `.hovered` class
  (pointer effect in `Notes.tsx`), **not** CSS `:hover` — WKWebKit's `:hover` chain
  goes stale when the auto-growing textareas resize under a stationary pointer,
  leaving buttons stuck on a note the pointer already left. Item rows don't
  resize, which is why they can keep plain `:hover`. Don't "simplify" notes back.
- An always-open capture field sits at the top of Notes: type + Enter creates a
  note. (Replaced the old `+` button + seed empty note.)
- Each note card collapses **in place**: the ⌃ button in its hover actions folds it to
  one line (its first non-empty **prose** line — a pending token line never previews),
  ellipsized — same card, just shorter, no layout
  swap. The collapsed card is one big click target: clicking it expands in place, a
  **reading action** — the keyboard stays alone (a focused note keeps its focus and the
  digits keep acting on it); editing is one more click into the text or `e`, which
  expands and then takes the caret. Its hover actions remain (⌄ ⬇ ◐ ×;
  action clicks stopPropagation so they don't double as the expand click). Collapsed ids
  persist in localStorage (`dayapp-notes-collapsed`), pruned on delete — a display
  preference, like zoom. No dedicated key — the focus grammar reaches it as digit `1`
  on a focused note (`n<tier><row>` then `1`).
- **Priority + projects via the token grammar** (see "Notes" under Data model):
  inline tokens at capture, or a blank line + tokens-only final line in an existing note,
  caught on blur — stripped from the body, applied to the columns (`flushAndCatch` →
  `handleCatchTokens`). No token leaves values alone; `!0`/`#0` clear. There is no
  metadata UI at all: the tier group is the priority signal, the collapsed label the
  project signal. The list **groups by tier like the Backlog** — P1 → P3 → unmarked
  under tier dividers labeled with the bars — every marked tier labels itself even when
  alone, an entirely unmarked list renders undivided; the cards carry no
  bars (the sections are the tier signal). The collapsed card shows the project label
  (right-aligned, the row language; the preview line yields the hover-action cluster
  its corner while revealed). A caught token that moves the tier re-lands the card in
  its group immediately (`sortNotes` mirrors the SQL ordering — the optimistic list is
  what the next refresh returns). The list narrows under the ⌘P `Priority 1/2/3 Notes`
  toggles, the ⌘F `#` project filter, and Focus Mode. Slot 1's collapse/expand glyph
  is the shared SVG chevron (flipped, flex-centered) — never unicode ⌃/⌄, which are
  two mismatched glyphs riding the font baseline.
- **⬇ download (slot 2):** exports the note's body as a `.txt` through the native save
  panel (`save_text_file` in `lib.rs` — `rfd`'s async panel, which dispatches to the
  main thread itself; the command returns `false` on cancel, not an error). The
  suggested filename is the note's first non-empty line (the same line the collapsed
  preview shows), sanitized, `.txt` appended. Shown on hover / focused like every
  action, only when the note has content (like ×); hidden notes skip it. Exporting
  flushes any debounced edit first, so the file always matches what's on screen.
- **⌘F is note-local while editing:** when a note's textarea (or the find bar itself)
  has focus, ⌘F opens a find bar on that note instead of the global item search —
  `Notes.tsx` captures the key on window (capture phase) ahead of App's global ⌘F.
  The bar is inline chrome at the top of the card while it lasts (not a floating
  surface — it belongs to the note). Matches paint through a transparent-text mirror
  div laid out under the textarea with identical metrics (`.note-mirror` in
  `index.css` — a textarea can't tint ranges itself): all matches a faint accent
  tint, the current one stronger. Enter / ↓ and ↑ / ⇧Enter step matches (wrapping;
  arrows only, never letters, in the field), the count reads `n/m`, and Esc closes
  the bar and refocuses the textarea with the current match selected — the find bar
  is the top rung of the Esc ladder. Query state is per note (persists across opens);
  the match index and query live in `NoteInput` beside the live text, not in App.

**Goals:**
- The identity layer at the top of the main page, above Notes: horizon groups in the
  order Timeless / Long term / Short term, each introduced by a `.tier-divider`
  hairline labeled with the horizon's name (the Backlog's tier-divider pattern, text
  label instead of bars; empty groups render no divider). Achieved goals collapse
  into a dim "Achieved" group at the bottom — they never delete on their own.
- Capture is line-only like the section inputs (no placeholder); it takes a leading
  horizon word (`timeless be a better person`, `long better entrepreneur #hustle`),
  plain text defaulting to short. Same parse on edit — no word leaves the tier alone.
- Rows are the `.item` language minus the grip: no DnD, no timer, no hide, no priority.
  Short/long rows carry a checkbox (achieve / unachieve, month-granular date on the
  achieved row); timeless rows show ∞ in that slot and can only be edited or deleted (×).
  Single-click enters edit; hover reveals # project assign + × delete — the same
  `ProjectMenu` items use. ⌘P → Show/Hide Goals toggles the whole section (persisted).
  Every mutation is logged to `actions` (goal_* values) — see the data model.

**Quote modal (⌘P → Show a Quote):**
- One quote at a time on a dim, blurred backdrop (`rgba(0,0,0,0.65)` +
  `backdrop-filter: blur(12px)`, deeper than the palette's 0.4 — the dim *is* the
  pause) — a single centered serif-italic line, ~75% width,
  multi-line wrap (never ellipsized), no card, no close button, no countdown chrome.
  The backdrop is what creates the "think about this" moment; an inline line can't.
  Static filter only — same never-animate-the-fixed-backdrop rule as below.
- **Summoned, never ambient.** The rotating quote line under the header (shipped
  2026-08-25, retired 2026-08-26) failed because a quote always in view becomes
  wallpaper — rarity plus deliberate invocation is what gives a quote weight. An
  uninvited modal is a push notification — it interrupts presence and trains
  reflex-dismissal. There is **no timed/wall-clock version**, with exactly one
  carve-out: the **quote screensaver** (next bullet), which arrives only in
  *absence* and so never interrupts. If any other cadence is ever wanted, anchor
  to interaction (app regaining visibility after ≥N hours — the daily-reset's
  render-time-comparison idiom), never wall-clock — and still never as a modal.
- **The quote screensaver (⌘P → Enable/Disable, default on, persisted
  `dayapp-quote-screensaver`):** two minutes of focused stillness summons the same
  modal unprompted. The idle clock runs only while the window is focused — away
  time never counts (Faraz's call, 2026-08-26: it's for sitting with the app, not
  having left it; `blur` restarts the clock, `document.hasFocus()` gates the
  trigger) — and only real user input resets it: keys, clicks, pointer movement,
  scrolling. App-driven re-renders (the timer's 1s tick, the 60s sweep, the
  masthead rotation) deliberately don't — DOM churn is not attention. Screensaver
  opens **linger until input** instead of `LINGER_MS` (a screensaver that dismisses
  itself back into blank idleness defeats itself — one quote per idle stretch, and
  the input that wakes it restarts the 2-min clock). The waking keystroke is
  already consumed by the dismissal handler's `preventDefault`, so it can't also
  type into whatever sat beneath. Gates: pool non-empty (the toggle hides with
  "Show a Quote" while it is) and no other floating surface open. The watcher
  lives in `App.tsx` (event bumpers + a 5s check); `Quotes.tsx` only learns the
  open is idle-born through `lingerForever`.
- Dismissal: any key (beyond a bare modifier chord — ⌘P/⌘F still work, their listener
  closes the modal) or any click ends it instantly; after ~45s (`LINGER_MS`) a ⌘P
  summon dismisses itself — the duration is a default, not a rule. Two WKWebView-era
  rules
  learned the hard way (the "modal never appears" bug, 2026-08-26): **the summoning
  keystroke must not double as its dismissal** (React commits `quoteOpen=true`
  synchronously during the palette's Enter handling, so the tail of that same event
  reaches the window handler with the fresh state — `quoteOpenedAt`'s 250ms grace
  window skips it), and **never animate the fixed full-screen backdrop** (the
  compositor left an animated fixed layer stuck at the `from { opacity: 0 }` frame —
  it never painted; only the quote text fades in). The pick never repeats the
  last-shown quote (the masthead rotation's rule, reused; session-only memory).
- Source: `##q` captures (the notes bus) — never projects, never logged. The palette
  entries hide while the pool is empty (`quoteCount` rides up from `Quotes.tsx` — no
  pool, nothing to summon). Not a layout toggle: Focus Mode and Show Default View don't
  special-case it (a summoned moment isn't ambient chrome). It is quotes' **only**
  surface — no management, no list anywhere (Faraz's call, 2026-08-25; capture-only
  unchanged). Component is `Quotes.tsx` (self-contained fetch + pick + linger; App owns
  the open boolean for the key-handler gate and bumps `version` on demo swaps and
  `##q` captures).

**Journal view (⌘P → View Journal, or the header `¶`):**
- The written journal's own page — Analytics replaced the old journal view, so `##j`
  entries get this one. The masthead reads `Journal`; the header button is a per-view
  toggle like `≡` (the active view's button reads ✕ and returns to the list).
- **Days ledger, prose edition**: days newest-first under uppercase day headers
  ("Today" / "Mon, Aug 24"), entries in capture order within a day. Rows are the
  `.item` language minus every axis an entry lacks (no grip/checkbox/bars): single-click
  edits inline (the shared `EditInput`), hover reveals × delete. Empty commit is a
  no-op; edits never move an entry's day.
- **Capture at the top is the bus with a default**: plain lines land as today's journal
  entries; a leading `##q` still routes to quotes from here. No placeholder — the
  section-input language.
- **Quotes never render here** (Faraz's call, 2026-08-25): the quote modal is their one
  surface and they carry no management surface at all for now — the view filters them out
  and shows journal entries only.
- Mouse-first like Analytics: no focus-grammar wiring (free-mode `j`/`k` scrolling works
  globally). Self-contained (`Journal.tsx`, the Notes pattern): remounts on every view
  switch so it always renders fresh data; `reloadEpoch` covers demo-mode swaps.

**Analytics view (⌘P → View Analytics, or the header `≡`):**
- The analytics page is **synthesis, never the log**: it answers questions over the
  append-only `actions` history, it does not enumerate events. The raw action log's
  textual home is the CLI (`--journal`); the GUI shows aggregates only. The masthead
  reads `Analytics`; the default range is **Week** (Today/Week/Month/All pills + the
  date jump).
- **Axis scope filters (the toolbar's right end, session-only like the range)**: a `#`
  project picker (multi-select popover, color dots, "No project" as a value) and four
  tier chips (the PriorityBars glyphs, empty track = unmarked) + Clear. OR within an
  axis, AND across the two. Every derivation follows (`journal_dashboard` /
  `journal_day_detail` take a `ScopeFilter` over the `actions` write-time snapshots, so
  filtered history stays deletion-proof): done/streak/avg, heatmap intensities, splits,
  ledger counts, day-detail rows, and the miss replay — a habit outside the filter is
  neither expected nor missed (population = the habit's current axes, since assignments
  are unlogged — the same "currently" call the hidden exclusion makes; the done-check
  reads the unfiltered completion set, so a reassigned habit never reads as a phantom
  miss). A split card whose axis is filtered hides (the filtered view already answers
  it — a card scoped to the selection would restate the filter while disagreeing with
  the Done stat). **Tracked time deliberately does not follow the filter** (Faraz's
  call, 2026-08-25 — the timer is barely used, not worth snapshot columns on `sessions`):
  while filtered the ledger hides its per-day time total and time alone can't surface a
  day row; per-task time still renders in an expanded day (it rides the filtered task
  rows). The Activity card is React-keyed on the rendered-sibling state because WKWebView
  doesn't re-resolve its aspect-ratio cells when the grid track re-widens on unfilter
  (the "heatmap didn't shrink back" bug, 2026-08-25).
- **Stats**: Done (effective completions — a complete→uncheck→never-again arc doesn't
  count, a re-completed misclick counts once), Avg/day (when the range spans >1 day),
  Streak (consecutive days with ≥1 completion; a live today with nothing yet doesn't
  break it), **Daily missed** (habits the day ended without — replayed from the log
  itself, so deleted habits count for the days they existed; currently-hidden items are
  excluded so an archived habit can't accrue misses forever; the current day never shows
  daily misses — a live day has no verdict), and **Today missed** (`fell_to_backlog` —
  the sweep's own record of a today task the day ended without).
- **Activity**: the current month as a Monday-first calendar heatmap — one square per
  day (aspect-ratio cells, so one shape serves every window width), intensity steps of
  the one accent = that day's completions, the day number top-left, the count
  bottom-right, today ringed, a Less→More legend. Clicking a cell picks that day — the
  ledger row expands to its tasks and the cell is ringed; clicking the picked day again
  clears the pick. A pick outside the active range widens the range to All so the row
  has somewhere to render. Picking never re-scopes the stats — the range pills own
  that.
- **Splits**: every project's share of the range's completions as label/bar/count rows
  (zero-filled from the roster so neglected projects read as 0; a trailing "none" bucket
  when unprojected work exists), and the priority card — one segmented bar (tier
  proportions as intensity steps of the accent, P1 the strongest) plus a signal-bars
  glyph legend. Both read the `actions.project`/`actions.priority` write-time snapshots.
- **Days ledger**: one line per day that had any signal — `MON, AUG 24 · 7 done · 1
  missed · 2h 7m` (time only when tracked). Clicking a row expands that day at task
  level (`journal_day_detail`): the tasks done that day (✓, HH:MM, tracked time), what
  fell to Backlog (↓), and the missed habits (○) — counts roll up, the expansion is the
  substance. The open row inverts against the card (bg recess) so the expansion reads as
  one unit. The picked day stays listed even when empty, so its expansion always has a
  row. Still counts-first: never the raw action stream.
- **Responsive**: the page is a stack of elevated cards (the token system's elevated
  surface — `.an-card`, bg-elev + border hairline + 12px radius): hero stats, then
  Activity · Projects · Priority in one band, then the days ledger on its own full-width
  row. The 480px window stacks all four; a wide window (Faraz fullscreens it via
  AeroSpace) puts the three middle cards side by side (`auto-fit minmax(280px, 1fr)` —
  the calendar's square cells size with their card). One `.scroll` flow either way: the
  grid columns are in-flow content, never nested scrollers.
- **No time stats in the stats row** (time appears only as the ledger's per-day total
  when it exists), and the page is mouse-first: no focus-grammar wiring (free-mode `j`/`k`
  scrolling still works, like every view). The one keyboard path is the project picker
  itself — `#` opens it (capture phase, inputs skipped), ↑/↓ walk the highlight, Enter
  toggles, `#`/Esc close; still not an addressable surface.

- Derivation lives in `src-tauri/src/dashboard.rs` (`journal_dashboard` +
  `journal_day_detail`, behind commands of the same names); the UI is `AnalyticsView.tsx`
  (self-contained, the Notes/Goals pattern). The CLI's `--journal` prints the same
  summary block ahead of the full raw log — the read surface mirrors the GUI, plus the
  log the GUI no longer shows.

### What NOT to add (explicit non-goals)

- No light theme. No `prefers-color-scheme`.
- No second accent colour. No status colours per section.
- No tags or arbitrary due-date fields. (Projects are a first-class filter axis; reminders
  are a date-granular promotion; timers are a measurement layer; priorities are a `!1..3`
  text token + Backlog sort — extended to notes 2026-08-24 with the same token grammar (inline at capture, own trailing line in a body) and Backlog-style tier grouping; goals are the horizon layer above the sections; agent
  delegation is a `@` token + robot badge — the "who executes" axis that the Phase 3
  agent-writes bridge will dispatch off. These are
  the deliberate scope expansions. Don't pile on more organising metadata on top.)
- No billable hours, no report exports, no charts product. The Analytics view (2026-08-25)
  is the sanctioned summary layer — pure synthesis of the log, single accent, intensity
  steps only, no time stats in the stats row (the timer's payoff stays the per-row
  cumulative + the per-day ledger total; `--journal` keeps the per-task breakdown).
  Don't grow it toward an analytics-surface product.
- No blank-page daily-note journaling surface. The activity journal IS the `actions` log
  (Analytics synthesizes it, `--journal` prints it); the *written* journal is `##j`
  entries captured through the notes bus and rendered by the Journal view — never a
  dedicated editor, prompts, or a per-day template. Don't grow the Journal view toward a
  journaling product.
- No agent writes (read-only bridge, planned Phase 3).
- Do not log Notes, Projects, goal-project assignment, reminder-setting, or timer sessions
  to `actions`.
- Do not add multi-select / bulk edit. This is a focused single-action tool.

---

## How to add a feature (the Notes pattern as a template)

DayApp features are built to be decoupled. When adding a feature area, mirror how Notes
was done — that's the house style:

1. **Own table in `schema.sql`** (added via `CREATE TABLE IF NOT EXISTS`, so existing DBs
   migrate for free). Decide upfront: is this **state + logged activity** (→ add to
   `actions`) or **content** (→ own table, not logged)?
2. **Own Rust module** (`src/xxx.rs`) with all its SQL as methods on the shared `Db` struct,
   touching only its own table. Keep it out of `db.rs`.
3. **Wire commands in `lib.rs`** through the existing `with_db` helper (blocking thread +
   `Result<_, String>`). Register them in `generate_handler!`.
4. **Own frontend module** (`src/Xxx.tsx` + `src/xxxApi.ts`) — own state, own persistence,
   own handlers. Do not entangle with `App.tsx`'s item state.
5. **Mount it in `App.tsx`** with a single line. If it's a text surface, mount it **outside**
   the `<DndContext>` so typing isn't a drag surface.
6. **Styles in `index.css`** under a clearly named section header comment. Reuse tokens.

---

## Build & run

```bash
cd Programming/dayapp
npm install            # first time only
npm run tauri dev      # hot-reloading dev window

npm run tauri build    # → src-tauri/target/release/bundle/macos/DayApp.app
```

The build targets the `.app` bundle only (no `.dmg` — `tauri.conf.json` sets
`"targets": ["app"]`), so there's no installer/drag-to-Applications screen. To install or
update the app from source, use one of:

```bash
npm run update         # build + swap /Applications/DayApp.app + relaunch (CLI)
# or, from inside the running app: ⌘P → "Update DayApp"
```

Both call `scripts/update.sh`. See the README "Update the installed app" section for the
mechanics (detached swap helper, LaunchServices re-registration).

To regenerate icons after editing `icon-source.svg`:

```bash
# render SVG → 1024 PNG (needs sharp), then:
npx tauri icon path/to/icon-1024.png
npm run tauri build
```

`tauri icon` also refreshes the Android launcher icons in `src-tauri/gen/android`
(the full-logo raster + the adaptive-icon foreground, which is the squircle
edge-to-edge so launchers mask it into their own shape), but it **resets the
adaptive background colour to `#fff`** — after every run, set
`ic_launcher_background` back to `#0e0f11` in both
`src-tauri/gen/android/app/src/main/res/values/ic_launcher_background.xml` and
`src-tauri/icons/android/values/ic_launcher_background.xml` (the app bg, so the
dark logo never flashes a white layer under launcher parallax effects).

### Toolchain note

A recent Rust is required (edition 2024, pulled transitively by tauri-build deps). If you
hit `feature 'edition2024' is required`, run `rustup update stable`.

---

## Working agreement

- **Discover before doing.** Read the relevant module before editing it.
- **Match the surrounding style** — comment density, naming, the token system.
- **Verify before reporting done.** `npx tsc --noEmit` for the frontend, `cargo build` for
  Rust, and `npm run tauri build` for end-to-end. "It compiles" is not "done."
- **Log new flows.** Any new lifecycle event, multi-step flow, or error path gets a log line
  (Rust `log::` / TS `log.`) per the Logging section above. Don't log routine CRUD — that's
  what the `actions` table is for.
- **Keep `README.md` in sync** with anything user-facing (new commands, new keybindings).
- **Commit on the default branch only when the work is complete and verified.**

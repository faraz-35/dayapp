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
| "What I did this week" | `SELECT FROM actions WHERE action='completed'`. Every mutation logs itself. The Journal view filters this by day/week/month. |
| "How long I worked on X" | `SELECT SUM(duration_secs) FROM sessions WHERE item_id=X`. ▶/⏸ write open/close timestamps; the Journal groups these by day. The open session row *is* the active timer — no separate state. |

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
  (driven by the `identifier` in `tauri.conf.json`).

### Stack rules (do not break these)

- **Rust commands return `Result<T, String>`, not `anyhow::Result`.** `anyhow::Error` is
  not `Serialize`, so Tauri can't pass it across IPC. The `with_db` helper in `lib.rs`
  stringifies errors into `Result<_, String>` for you — always go through it.
- **All SQLite work runs on a blocking thread.** rusqlite is synchronous. The `with_db`
  helper wraps each command in `tauri::async_runtime::spawn_blocking`. Never call `Db`
  methods directly from a command body.
- **One `Mutex<Connection>`.** DayApp is single-user, single-process, low-concurrency.
  No pool dependency needed.
- **Every write to `items` is wrapped in a transaction that also appends to `actions`.**
  The log must never drift from the live row.

---

## Data model

Two independent feature areas, deliberately decoupled:

### Items (stateful lists + the journal)

```
items   id, text, section, status, last_completed_date, sort_order, created_at, updated_at,
        hidden, hidden_until, project_id, remind_at, priority
actions id, item_id, item_text, action, from_section, to_section, from_status, to_status, timestamp
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
  (`exclude | include | only` — the three ⌘P visibility modes) instead of always
  filtering `hidden = 0`; in `include`/`only` modes archived rows render inline in
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
  first, then manual order — DnD reorders within a tier) and tier boundaries there render
  as hairline dividers whose label is the entering tier's bars (bare hairline before the
  unprioritized tail — derived purely from the rendered order in `SectionView.tsx`, so
  filters that drop tiers drop their dividers); Today/Daily stay manual.
- `remind_at` — ISO `YYYY-MM-DD` on which a backlog item auto-promotes to `today`. The
  promotion is logged as a `moved` action (backlog→today) and `remind_at` is cleared so it
  fires once. Date-granular, fires on launch (no cron / no macOS notification).
- `actions.action` ∈ `created | completed | uncompleted | moved | edited | deleted | fell_to_backlog`
- **`actions.item_text` is snapshotted at write time.** History must survive edits and
  deletions — if it referenced the live row, renaming a task would silently rewrite the
  past.

### Notes (free-form content — NOT logged)

```
notes   id, body, sort_order, created_at, updated_at
```

Notes are **content**, not **activity**. They have their own table and are never written
to `actions`. Do not add notes to the journal.

### Projects (a second organising axis — NOT logged)

```
projects id, name, sort_order, created_at
```

Projects let each item carry a color-coded label on the far right of its row (deterministic
hue per project, so the eye groups items across sections). Assignment is housekeeping (like
hide) — **never** logged to `actions`. `items.project_id` is the nullable FK (no enforced
cascade; deleting a project runs `UPDATE items SET project_id = NULL`). Logic lives in
`src-tauri/src/projects.rs`; the popover is `src/ProjectMenu.tsx`.

### Reminders (scheduled promotion via sweep — logged as `moved`)

`items.remind_at` holds an ISO date. On app launch (`setup`, un-gated, idempotent),
`promote_due_reminders()` moves any backlog item whose `remind_at <= today` to `today`,
clears `remind_at`, and logs a `moved` action. No new action enum — reusing `moved` keeps
the `actions` CHECK constraint untouched. Date-granular and fires only when the app is open
(no background daemon); setting a reminder is **not** logged.

### Timers (per-task time tracking — NOT logged)

```
sessions id, item_id, item_text, started_at, ended_at, duration_secs
```

A **single active timer**: at most one row has `ended_at IS NULL`, and that open row *is*
the running timer — there is no separate "active timer" state anywhere. ▶ opens a row;
⏸ fills `ended_at` + `duration_secs`. Starting a new timer finalizes the previous open
session first (single-timer invariant, enforced in `start_timer`). Like Notes/Projects,
sessions are **measurement (content)**, not item-state transitions, so they are **never**
logged to `actions` — the Journal surfaces time as a separate dimension via
`session_time_by_day`, which splits sessions across midnight so daily totals are accurate.

- `item_text` is snapshotted at write time (like `actions.item_text`), so the Journal's
  per-task breakdown survives edits and deletions.
- The active timer **persists across app restarts** (the open row is the source of truth).
  If the app closes mid-session the elapsed keeps counting honestly on reopen; the header
  chip's × discards the session for the "left it running overnight" case.
- Completing or deleting a running item stops its timer first (the session is kept).
- Logic lives in `src-tauri/src/timers.rs`; the row control is in `src/components/ItemRow.tsx`,
  the header chip + `t` keybinding in `src/App.tsx`. Live elapsed ticks once a second in the
  frontend; the backend is stateless between ticks (it derives elapsed from `started_at`).

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
  promotion sweep (`reminders: N backlog item(s) promoted to today`).
- **Every external-flow step at INFO:** the `self_update` command logs each phase (starting
  build → build succeeded → spawning swap helper → exiting app). This is the critical path
  to debug update failures.
- **Errors at ERROR:** failed spawns, failed builds, failed IPC. Always include the
  underlying error in the message.
- **Do NOT log routine CRUD.** Per-row create/complete/move is already captured in the
  `actions` table — that's the journal. Logging it again is noise. Log only state transitions
  the user can't otherwise see (sweeps, migrations, the update handoff).

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
│   ├── App.tsx                     ← shell only: state, effects, keyboard handlers, header, view switching, timer chip
│   ├── lib.ts                      ← items typed API wrapper + types + date helpers + projectsApi + timersApi + projectColor/formatReminder/formatDuration
│   ├── notesApi.ts                 ← notes typed API wrapper
│   ├── log.ts                      ← prefixed console logger (webview side)
│   ├── main.tsx                    ← React entry
│   ├── index.css                   ← the dark theme + all component styles
│   ├── Notes.tsx                   ← self-contained notes component (own state + persistence)
│   ├── HideMenu.tsx                ← shared ◐ hide-duration popover (items + notes)
│   ├── ProjectMenu.tsx             ← # assign/clear/create project popover (per item)
│   ├── ReminderMenu.tsx            ← ◷ reminder-date popover (per item); promotion via sweep
│   ├── CommandPalette.tsx          ← ⌘P modal: filter + keyboard nav
│   ├── UpdateOverlay.tsx           ← self-update progress/restart/error modal
│   └── components/                 ← feature components, one per file (see "Component responsibilities")
│       ├── SectionList.tsx         ← DndContext + drag handlers + maps the 3 sections
│       ├── SectionView.tsx         ← one section (head + capture input + sortable items + dropzone; Backlog tier dividers)
│       ├── ItemRow.tsx             ← one item row (▶/⏸ timer control) + inline EditInput + shared PriorityBars
│       ├── JournalView.tsx         ← the journal: actions log + per-task time, grouped by day
│       └── SearchMenu.tsx          ← ⌘F floating search modal (↑/↓ + Enter to jump; leading # = project filter)
└── src-tauri/
    ├── src/
    │   ├── lib.rs                  ← Tauri commands + setup (sweep, reminders, logging plugin) + self_update
    │   ├── db.rs                   ← DB layer: items, actions, sweep, hide, reminders, completions + Db struct
    │   ├── notes.rs                ← notes DB logic (methods on Db, touches only notes table)
    │   ├── projects.rs             ← projects DB logic + item.project_id assignment (methods on Db)
    │   ├── timers.rs               ← timer sessions: start/stop/discard/totals/per-day (methods on Db)
    │   └── main.rs                 ← binary entrypoint
    ├── schema.sql                  ← items + actions + meta + notes + projects + sessions
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
| `App.tsx` | state (incl. the active timer), effects, keyboard handlers, header + timer chip, view switching | rendering of items/rows, DnD logic, view internals |
| `SectionList.tsx` | `DndContext`, drag start/end, `DragOverlay`, the 3-section map | item state mutations (delegates via `onMoveItem`) |
| `SectionView.tsx` | one section's header + capture input + sortable items + dropzone (+ Backlog tier dividers) | DnD sensors/handlers |
| `ItemRow.tsx` | one row's render + ▶/⏸ timer control + `EditInput` | DnD wiring (from `useSortable` via parent) |
| `JournalView.tsx` | fetching + filtering + grouping the actions log + per-task time totals | — |
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
    Notes / SectionList / JournalView                           ← in-flow, no own scroll
```

`.notes`, `.sections`, `.journal`, `.hidden-view` must **not** set `overflow`,
`max-height`, `flex: 1`, or `min-height: 0` — they are plain in-flow blocks
inside `.scroll`. If you ever need a region to scroll independently, you are
changing the architecture: update this section and justify why.

### 2. Floating surfaces vs inline chrome

There are two kinds of UI elements, and they must not be mixed:

- **Inline chrome** — capture inputs, section heads, item rows, notes. These
  live in the `.scroll` flow and push content. `position: static`/`relative`.
- **Floating surfaces** — `CommandPalette` (⌘P), `SearchMenu` (⌘F),
  `UpdateOverlay`. These are transient overlays: `position: fixed; inset: 0` +
  a dim `rgba(0,0,0,0.4)` backdrop + a centered card, mounted at the end of
  `.app` (not inside `.scroll`). They float *over* content; they never push it.

**Never mount a floating surface as an inline flex sibling** — it consumes
layout space and "feels inline." The backdrop + centered card is what makes a
modal read as transient. Match `.palette-backdrop`/`.palette` exactly when
adding a new one.

`z-index` ordering: command palette `100` > search `90` > update overlay `110`.
(Update is highest because it represents an in-flight, non-cancellable swap.)

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
3. **Keyboard-first.** DnD exists, but `j`/`k`/`Enter`/`e`/`⌫` are the primary path. A
   feature that's mouse-only is incomplete.
4. **Dense rows, single-line text, ellipsis.** This is a list, not a document.
5. **One accent colour.** `#7b8cff` means "active/selected/completed/done-today." Do not
   introduce a second accent.
6. **Dark, always dark.** No light theme, no `prefers-color-scheme` switching. `color-scheme: dark`.
7. **Zero inertia for capture.** The lowest-friction surface (Notes) renders first, above
   everything else. There is always a ready textarea.

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
The one serif surface is the centered header masthead (the "Faraz's Day" brand, or
"Journal" in the journal view): `ui-serif` (New York) italic at 14px, Didot/Georgia
fallbacks. It is always rendered, even while a timer runs — the timer chip shows only
a pulse + elapsed (task name in its tooltip) so the two coexist on the 480px window;
below 455px of width a media query hides the masthead.

### Spacing & shape

- Rows: `padding: 6px 8px`, `border-radius: 6px`.
- Inner action buttons: 22×22, `border-radius: 4px`.
- Header icon buttons: 24×24, `border-radius: 5px`.
- Transitions: `0.08s–0.12s ease` for hover/focus. Snappy, not slow.
- The header uses `-webkit-app-region: drag` so the title bar drags the window; buttons in
  the header re-set `-webkit-app-region: no-drag`.

### Interaction patterns (existing — match these for new features)

**Item rows:**
- Resting: the checkbox circle + text, plus any right-aligned metadata (priority signal
  bars, `⏱` cumulative time, project label, reminder chip). Rows with no priority / tracked
  time / project / reminder show only checkbox + text — and Backlog rows never show bars:
  tier boundaries between neighbours render as `.tier-divider` hairlines labeled with the
  tier's bars (Backlog only — never Today/Daily).
- Hover: row bg → `--bg-hover`; grip (⠿) + ▶ timer + project/reminder/hide + delete (×) buttons
  fade in. The priority bars + project label stay visible (the row's identity, wanted while its
  actions are on screen); the time / reminder / hidden metadata fades out. Checkbox circle
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

**DnD:**
- Drag via the grip handle, not the whole row (so text selection and typing aren't fights).
- `PointerSensor` with a 4px activation distance — prevents accidental drags on click.
- Empty sections are droppable zones (`useDroppable` per section) with a subtle highlight on hover.
- Optimistic reorder in React; `api.moveItem` persists; backend re-indexes sort_order.

**Keyboard:**

| Key | Action |
|---|---|
| `j` / `↓` | select next |
| `k` / `↑` | select previous |
| `Enter` | complete selected (toggles a crossed Today row back to active) |
| `e` | edit selected |
| `t` | start/stop timer on selected (toggles; starting stops any other) |
| `⌫` / `Delete` | delete selected |
| single-click | select + enter edit mode (caret at end, not full-select) |
| `⌘P` / `Ctrl+P` | command palette (visibility modes, update, jump to view, …) |
| `⌘F` / `Ctrl+F` | search items — floating modal, ↑/↓ + Enter to jump; a leading `#` flips it to the project filter picker |
| `⌘+` / `⌘-` | zoom the whole UI in/out (`⌘0` resets) — CSS `zoom` on `<html>`, persisted in localStorage (`dayapp-zoom`); scales every px dimension together, so the design's proportions hold at any size |

**Visibility modes (⌘P):** `Show Regular View` (default — hidden entries excluded),
`Show All` (hidden entries inline, dimmed, ↺/× actions), `Show Hidden Only` (only hidden
entries). All three render the same main page (Notes + sections) — they're filters, not
separate views; capture inputs are suppressed in hidden-only mode, and unhiding there pops
the row out. The mode lives in `App.tsx` as `visibility` state, session-only; the header ◐
button toggles hidden-only.

**Priority filter (⌘P):** `Show Priority 1/2/3 Only` narrows the main list to one tier
(`displayItems` in `App.tsx`; DnD indexes map back to full-list space in `handleMoveItem`).
Re-running the active tier's command clears it.

**Project filter (⌘F `#`):** typing a leading `#` in the ⌘F search flips the hit list to the
projects (color dot + name, narrowed by the text after the `#`); picking one narrows the main
list to that project, picking the already-active one clears it (the same toggle rule as the
priority tiers). Same `displayItems` pipeline — it composes with the priority tier.

**Show Regular View is the universal reset:** it clears the visibility mode, priority tier,
and project filter together — one command always restores the plain unfiltered list.

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

### What NOT to add (explicit non-goals)

- No light theme. No `prefers-color-scheme`.
- No second accent colour. No status colours per section.
- No tags or arbitrary due-date fields. (Projects are a first-class filter axis; reminders
  are a date-granular promotion; timers are a measurement layer; priorities are a `!1..3`
  text token + Backlog sort — these are the deliberate scope expansions. Don't pile on more
  organising metadata on top.)
- No time-tracking reports / billable hours / charts. The timer's payoff is the per-row
  cumulative + the Journal's per-day, per-task totals — not an analytics surface.
- No journal surface / blank-page daily note. The log IS the journal.
- No agent writes (read-only bridge, planned Phase 3).
- No sync/cloud. Local SQLite only.
- Do not log Notes, Projects, reminder-setting, or timer sessions to `actions`.
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

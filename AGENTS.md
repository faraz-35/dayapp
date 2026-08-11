# DayApp — Agent Guide

A native macOS "live today list" with auto-journaling. Not a journal app — a focused
daily-action tool whose **timestamped action log** *is* the journal, for free. Also
includes free-form **Notes** (the notepad-replacement surface).

Before touching code, read this whole file. The UI/UX section is **load-bearing** — every
decision in it exists for a reason and must be followed, not relitigated.

---

## Product philosophy

The whole app is built on one insight: **three behaviours that sound like features are
just queries over timestamped state.** No cron, no background jobs.

| Behaviour | How it actually works |
|---|---|
| Daily items reset overnight | `last_completed_date == today` comparison on render. At midnight the comparison just stops being true. |
| Today items fall to Backlog | `run_sweep()` runs on launch (gated by `meta.last_sweep_date`). Idempotent. |
| Backlog reminders promote to Today | `promote_due_reminders()` runs on launch (un-gated, idempotent): backlog rows with `remind_at <= today` move to `today`. |
| "What I did this week" | `SELECT FROM actions WHERE action='completed'`. Every mutation logs itself. The Journal view filters this by day/week/month. |

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
        hidden, hidden_until, project_id, remind_at
actions id, item_id, item_text, action, from_section, to_section, from_status, to_status, timestamp
meta    key, value           — currently holds last_sweep_date
```

- `section` ∈ `today` | `daily` | `backlog`
- `status` ∈ `active` | `done`
- `hidden` ∈ `0` | `1` — soft-archive; `list_*` filters `hidden = 0`. `hidden_until` is NULL
  (forever) or an ISO date cleared by the midnight sweep. Hide/unhide is **not** logged to
  `actions` — it's housekeeping, not activity.
- `project_id` — optional assignment to a `projects` row (housekeeping; **not** logged). Shown
  as a color-coded label on the far right of each item row (deterministic hue per project id).
  Deleting a project nulls the FK (items kept).
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
│   ├── App.tsx                     ← shell only: state, effects, keyboard handlers, header, view switching
│   ├── lib.ts                      ← items typed API wrapper + types + date helpers + projectsApi + projectColor/formatReminder
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
│       ├── SectionView.tsx         ← one section (head + capture input + sortable items + dropzone)
│       ├── ItemRow.tsx             ← one item row + inline EditInput
│       ├── JournalView.tsx         ← the journal: actions log grouped by day
│       ├── HiddenView.tsx          ← soft-archive view: unhide/delete hidden items + notes
│       └── SearchMenu.tsx          ← ⌘F floating search modal (↑/↓ + Enter to jump)
└── src-tauri/
    ├── src/
    │   ├── lib.rs                  ← Tauri commands + setup (sweep, reminders, logging plugin) + self_update
    │   ├── db.rs                   ← DB layer: items, actions, sweep, hide, reminders, completions + Db struct
    │   ├── notes.rs                ← notes DB logic (methods on Db, touches only notes table)
    │   ├── projects.rs             ← projects DB logic + item.project_id assignment (methods on Db)
    │   └── main.rs                 ← binary entrypoint
    ├── schema.sql                  ← items + actions + meta + notes + projects
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
| `App.tsx` | state, effects, keyboard handlers, header, view switching | rendering of items/rows, DnD logic, view internals |
| `SectionList.tsx` | `DndContext`, drag start/end, `DragOverlay`, the 3-section map | item state mutations (delegates via `onMoveItem`) |
| `SectionView.tsx` | one section's header + capture input + sortable items + dropzone | DnD sensors/handlers |
| `ItemRow.tsx` | one row's render + `EditInput` | DnD wiring (from `useSortable` via parent) |
| `JournalView.tsx` | fetching + filtering + grouping the actions log | — |
| `HiddenView.tsx` | listing/unhiding/deleting hidden items + notes | — |
| `SearchMenu.tsx` | ⌘F modal state + keyboard nav + jump | the hit list (passed in from `App`) |

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
    Notes / SectionList / JournalView / HiddenView              ← in-flow, no own scroll
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

### Spacing & shape

- Rows: `padding: 6px 8px`, `border-radius: 6px`.
- Inner action buttons: 22×22, `border-radius: 4px`.
- Header icon buttons: 24×24, `border-radius: 5px`.
- Transitions: `0.08s–0.12s ease` for hover/focus. Snappy, not slow.
- The header uses `-webkit-app-region: drag` so the title bar drags the window; buttons in
  the header re-set `-webkit-app-region: no-drag`.

### Interaction patterns (existing — match these for new features)

**Item rows:**
- Resting: only the checkbox circle + text.
- Hover: row bg → `--bg-hover`; grip (⠿) + edit (✎) + delete (×) buttons fade in; checkbox
  circle border → `--accent`.
- Done (non-daily): status flips, row removed from active view, completion logged.
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
| `Enter` | complete selected |
| `e` | edit selected |
| `⌫` / `Delete` | delete selected |
| single-click | select + enter edit mode (caret at end, not full-select) |
| `⌘P` / `Ctrl+P` | command palette (update, jump to view, …) |
| `⌘F` / `Ctrl+F` | search items — floating modal, ↑/↓ + Enter to jump |

The keyboard handler **ignores events when an `<input>`/`<textarea>` is focused** so typing
into Notes or edit fields isn't hijacked.

**Notes:**
- Auto-growing `<textarea>` (height driven by JS, `resize: none`, no internal scrollbar).
- Debounced autosave (600ms) + save-on-blur.
- Delete button appears on hover, only when there's content.
- An always-open capture field sits at the top of Notes: type + Enter creates a
  note. (Replaced the old `+` button + seed empty note.)

### What NOT to add (explicit non-goals)

- No light theme. No `prefers-color-scheme`.
- No second accent colour. No status colours per section.
- No priorities, tags, or arbitrary due-date fields. (Projects are now a first-class
  filter axis; reminders are a date-granular promotion — these are the deliberate scope
  expansions. Don't pile on more organising metadata on top.)
- No journal surface / blank-page daily note. The log IS the journal.
- No agent writes (read-only bridge, planned Phase 3).
- No sync/cloud. Local SQLite only.
- Do not log Notes, Projects, or reminder-setting to `actions`.
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

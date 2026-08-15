# DayApp

A native macOS "live today list" with auto-journaling. Not a journal app — a focused
daily-action tool whose **timestamped action log** *is* the journal, for free.

## The idea

Three sections: **Today**, **Daily**, **Backlog**. Drag between them. An item is a single
text field with a done button. Three behaviours fall out of the data model, no cron needed:

| Behaviour | How |
|---|---|
| Daily items reset overnight | `WHERE last_completed_date == today` on render — at midnight the comparison just stops being true |
| Today items fall to backlog | `run_sweep()` runs on launch (gated by `meta.last_sweep_date`); idempotent. Completed Today rows stay crossed in place until that sweep deletes them |
| Reminders promote backlog → today | A backlog item's `remind_at` date comes due → `promote_due_reminders()` moves it to Today on launch; fires once, no cron |
| "What I did this week" | `SELECT FROM actions WHERE action='completed'` — the log writes itself on every mutation; the Journal view narrows to Today/Week/Month or any day |
| "How long I worked on X" | `SELECT SUM(duration_secs) FROM sessions WHERE item_id=X` — ▶/⏸ write open/close timestamps; the Journal groups them by day |
| Hide tasks/notes for a while | `hidden=1` + optional `hidden_until` date; `list_*` filters `hidden=0`. The midnight sweep clears expired hides, so "hide for a day/week/month" auto-restores with no cron |

Every action (create/complete/move/edit/delete/sweep) is appended to `actions`. That table
powers the journal view (top-right `≡` icon); the journal also layers in tracked time (from
the separate `sessions` table) as a per-day total and per-task breakdown.

## Stack

- **Tauri 2** (Rust backend + native macOS window)
- **React + Vite + TypeScript** frontend
- **SQLite** via `rusqlite` (bundled — no system SQLite dependency)
- **@dnd-kit** for drag-and-drop

## Develop

```bash
npm install
npm run tauri dev      # hot-reloading dev window
```

## Build a release `.app`

```bash
npm run tauri build
# → src-tauri/target/release/bundle/macos/DayApp.app
```

The `.dmg` step will fail without Apple notarization credentials — that's expected; the
`.app` itself builds fine. Run it with:

```bash
xattr -dr com.apple.quarantine path/to/DayApp.app   # clear Gatekeeper flag
open path/to/DayApp.app
```

## Update the installed app

**From inside the app (recommended):** open the command palette with **⌘P**, choose
**Update DayApp**, and watch the build stream live in an overlay. On success the app quits
itself, swaps the bundle, and relaunches — no Terminal, no dragging. If the build fails, the
overlay shows the error and the app keeps running unchanged.

**From the terminal:** `npm run update` does the same thing (build + swap + relaunch) without
the live overlay. Useful when you're already in the repo, or for scripting.

Both paths call `scripts/update.sh`. A running app can't swap its own bundle, so the in-app
updater builds in-process, then spawns the script detached (via `setsid`, so it survives the
app exiting) and quits; the orphaned script waits for the app to quit, re-registers the new
bundle with LaunchServices, replaces `/Applications/DayApp.app`, and reopens it. Builds target
only the `.app` bundle (no `.dmg`), so there's no installer/drag-to-Applications screen ever.
Your data in `~/Library/.../dayapp.db` is never touched.

## Command palette (⌘P)

VS Code / Linear–style: press **⌘P** anywhere, type to filter, ↑/↓ to move, Enter to run.
Currently: the three visibility modes (Show Regular View / Show All / Show Hidden Only),
priority filters (Show Priority 1/2/3 Only), View Journal, and Update DayApp. Trivially
extensible — add a command to the registry in `App.tsx`.

## Where things live

```
dayapp/
├── src/
│   ├── App.tsx              ← shell: state, effects, keyboard handlers, header, view switching
│   ├── lib.ts               ← typed Tauri invoke wrappers + types + date/color helpers
│   ├── Notes.tsx            ← free-form notes (own state + API)
│   ├── notesApi.ts          ← notes invoke wrappers
│   ├── HideMenu.tsx         ← shared ◐ hide-duration popover
│   ├── ProjectMenu.tsx      ← # assign/clear/create project popover
│   ├── ReminderMenu.tsx     ← ◷ reminder-date popover
│   ├── CommandPalette.tsx   ← ⌘P command palette modal
│   ├── UpdateOverlay.tsx    ← self-update progress modal
│   ├── components/          ← feature components (SectionList, SectionView, ItemRow,
│   │                          JournalView, SearchMenu)
│   ├── main.tsx             ← React entry
│   └── index.css            ← dark Linear-flavoured theme
└── src-tauri/
    ├── src/
    │   ├── lib.rs           ← Tauri commands + setup (runs sweep + reminders on launch)
    │   ├── db.rs            ← DB layer: items, actions, sweep, hide, reminders, completions
    │   ├── notes.rs         ← notes DB logic
    │   ├── projects.rs      ← projects DB logic + item.project_id assignment
    │   ├── timers.rs        ← timer sessions: start/stop/discard/totals/per-day
    │   └── main.rs          ← binary entrypoint
    ├── schema.sql           ← items + actions + meta + notes + projects + sessions
    ├── Cargo.toml
    └── tauri.conf.json
```

**Database:** `~/Library/Application Support/com.farazshah.dayapp/dayapp.db`

## Keyboard shortcuts

| Key | Action |
|---|---|
| `j` / `↓` | select next |
| `k` / `↑` | select previous |
| `Enter` | complete selected (on a crossed Today row: un-complete) |
| `e` | edit selected |
| `t` | start/stop timer on selected (toggles; starting stops any other) |
| `⌫` / `Delete` | delete selected |
| single-click | select + edit (caret at end) |
| drag handle (⠿) | drag between sections |
| hover **▶** | start / stop a timer on the item |
| hover **#** | assign / clear / create project for the item |
| hover **◷** | set a reminder (Tomorrow / 3 days / week / pick date) |
| hover **◐** | hide item/note (forever / day / week / month) |
| `⌘P` / `Ctrl+P` | command palette (update, jump to view, …) |
| `⌘F` / `Ctrl+F` | search items — floating modal, ↑/↓ + Enter to jump; a leading `#` switches it to the project filter |
| `⌘+` / `⌘-` | zoom the whole UI in/out (`⌘0` resets; persists across launches) |

## Hiding

Not everything in a list matters today. Hover any task or note and click **◐** to
hide it — forever, or for a day / week / month. Hidden rows leave the regular list
entirely (no faded clutter).

The three visibility commands in the ⌘P palette are all filters over the same main
page — there is no separate archive screen:

- **Show Regular View** — the default; hidden entries are excluded. This is
  also the universal reset: it clears the priority and project filters too,
  so one command always brings back the plain list.
- **Show All** — hidden tasks appear inline in their sections and hidden notes
  back in the notes list: dimmed, marked **◐** with the hide's expiry, hover
  actions reduced to unhide (↺) and delete.
- **Show Hidden Only** — the main page showing just the hidden entries (the
  header's **◐** icon is a shortcut for this one). Capture inputs are hidden
  here, and unhiding a row pops it back out of the view.

The mode is per-session — a relaunch always starts regular.

Time-limited hides auto-restore: `hidden_until` is an ISO date, and the same
midnight sweep that drops Today items into Backlog also clears any expired hide,
so nothing needs a timer. Hiding is **not** logged to the journal — it's
housekeeping, not activity.

## Projects

Projects are a second organising axis alongside the three sections. Hover any
item and click **#** to assign it to a project (or clear it), or type a name and
press Enter to create a new one. Each item shows its project as a small,
**color-coded** label on the far right of the row — the color is stable per
project, so you can group items across sections at a glance. The label fades out
on hover to make room for the row's action buttons.

You can also assign a project right from the capture field: end the text with a
`#tag` and it links to the project. Matching is case-insensitive by exact name
or a unique prefix (`#day` → "dayapp"). If the tag matches **no** existing
project, a new one is created from it — but only when the tag is the last thing
typed (`fix bug #acme` creates "acme"; `fix bug #acme notes` does not). The tag
is stripped from the row once linked. (Tags compose with `!1..3` priority
tokens — see [Priorities](#priorities).)

To focus on one project's work, press **⌘F and type `#`**: the search list
becomes your projects (keep typing after the `#` to narrow it), each shown with
its color dot. Pick one — ↑/↓ + Enter or a click — and the main list shows only
that project's tasks. The filtered project is marked **filtered** in the list;
picking it again clears the filter, as does **⌘P → Show Regular View**. The
filter composes with the priority tiers and lasts for the session only.

Assigning a project is housekeeping — it's **not** logged to the journal (only
completion/movement is). Deleting a project unassigns its items; the items
themselves are kept.

## Priorities

End (or start) a task's text with `!1`, `!2`, or `!3` to give it a priority —
at capture or on any later edit (the token is stripped from the row). The token
composes with `#tags` in either order: `fix bug #acme !1`, `fix bug !1 #acme`,
or either one alone. Editing with a `!N` token updates the priority; editing
without one leaves it alone; `!0` clears it.

Each row shows its tier as bangs on the right — `!`, `!!`, `!!!` (brighter =
more urgent) — and the **Backlog is sorted by priority**: tier 1 first, no
priority last, manual drag order within a tier. Today and Daily keep their
manual order.

**⌘P → Show Priority 1/2/3 Only** filters the whole list down to one tier
(each command's hint shows its bangs). Re-run the active tier's command — or
**Show Regular View** — to clear the filter. Priorities are housekeeping, like
projects: not logged to the journal.

## Reminders

A reminder schedules a backlog item to auto-promote to Today on a future date.
Hover any item and click **◷** to pick **Tomorrow / In 3 days / In a week**, or
choose any date. A set reminder shows as an accent chip on the row (e.g.
`→ Aug 12`) so upcoming promotions are visible without hovering.

Reminders are **date-granular** (not time-of-day) and fire when the app is open:
on launch, `promote_due_reminders()` moves any backlog item whose date has come
due into Today, clears the reminder so it fires once, and logs a `moved` action.
There's no background daemon and no macOS notification — consistent with the
app's no-cron model. If the app is closed on the due day, the promotion happens
the next time you open it.

## Time tracking

Each task can carry a **single global timer** — start work on one thing at a
time. Hover an item and click **▶** (or select it and press **`t`**) to start;
the running row shows a live `H:MM:SS` in the accent colour, and a chip in the
header mirrors it so the timer survives scrolling away. Starting a timer on
another task stops the current one. Click the chip to **stop** (the session is
kept), or **×** to **discard** it (for the "left it running overnight" case).

Tracked time shows up two ways: a faint `⏱ 2h 14m` cumulative label on each row
that has any, and — in the Journal — a per-day total in each day header plus a
per-task breakdown. Time tracking is **not** logged to `actions`; sessions live
in their own `sessions` table and are layered into the journal as a separate
dimension. Completing or deleting a running item stops its timer first.

## Not yet built (intentional)

- Global hotkey to toggle the window (Phase 2)
- Menu bar presence (Phase 2)
- Undo toast on destructive ops (Phase 1)
- Agent query tool — read-only bridge for external skills to query the DB (Phase 3)
- Sync / cloud. Local SQLite only.

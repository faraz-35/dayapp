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
Currently: Show Default View (the universal reset), the Show/Hide toggles — Goals, Notes,
Today / Daily / Backlog, Hidden Tasks, Hidden Notes, Priority 1/2/3, Agent Tasks — the mobile
sync commands (Deploy Task List Now / Pull Captures Now / Configure Sync…), View Journal, and
Update DayApp. Trivially extensible — add a command to the registry in `App.tsx`.

## Where things live

```
dayapp/
├── src/
│   ├── App.tsx              ← shell: state, effects, keyboard handlers, header, view switching
│   ├── lib.ts               ← typed Tauri invoke wrappers + types + date/color helpers
│   ├── Notes.tsx            ← free-form notes (own state + API)
│   ├── Goals.tsx            ← goals: horizon groups + capture + achieve (own state)
│   ├── notesApi.ts          ← notes invoke wrappers
│   ├── HideMenu.tsx         ← shared ◐ hide-duration popover
│   ├── ProjectMenu.tsx      ← # assign/clear/create project popover
│   ├── ReminderMenu.tsx     ← ◷ reminder-date popover
│   ├── CommandPalette.tsx   ← ⌘P command palette modal
│   ├── UpdateOverlay.tsx    ← self-update progress modal
│   ├── MobileView.tsx       ← Android client: read-only list + capture bar
│   ├── MobileSyncSettings.tsx ← ⌘P sync-config modal (repo/branch/token)
│   ├── components/          ← feature components (SectionList, SectionView, ItemRow,
│   │                          JournalView, SearchMenu)
│   ├── main.tsx             ← React entry
│   └── index.css            ← dark Linear-flavoured theme
└── src-tauri/
    ├── src/
    │   ├── lib.rs           ← Tauri commands + setup (sweeps, sync loop on launch)
    │   ├── db.rs            ← DB layer: items, actions, sweep, hide, reminders, completions
    │   ├── notes.rs         ← notes DB logic
    │   ├── projects.rs      ← projects DB logic + item.project_id assignment
    │   ├── goals.rs         ← goals DB logic: horizons, achieve, project link
    │   ├── timers.rs        ← timer sessions: start/stop/discard/totals/per-day
    │   ├── sync.rs          ← mobile sync: tasks.json export/deploy + capture inbox pull
    │   ├── cli.rs           ← headless --list/--add/--complete/--start/--goals for remote access
    │   └── main.rs          ← binary entrypoint (GUI, or CLI when given flags)
    ├── schema.sql           ← items + actions + meta + notes + projects + goals + sessions
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
| `d` | toggle selected task's details — the spec under the title (for 🤖 tasks, the agent's prompt) |
| `t` | start/stop timer on selected (toggles; starting stops any other) |
| hover **⌃** (note) | collapse the note to its first line, in place; click the collapsed note (or **⌄**) to expand it with the caret at the end — one click back to editing |
| `⌫` / `Delete` | delete selected |
| single-click | select + edit (caret at end) |
| drag handle (⠿) | drag between sections |
| hover **▶** | start / stop a timer on the item |
| hover **#** | assign / clear / create project for the item |
| hover **◷** | set a reminder (Tomorrow / 3 days / week / pick date) |
| hover **◐** | hide item/note (forever / day / week / month) |
| `⌘P` / `Ctrl+P` | command palette (update, jump to view, …) |
| `⌘F` / `Ctrl+F` | search items — floating modal, ↑/↓ + Enter to jump; a leading `#` switches it to the project filter, a leading `@` to the agent/my filter |
| `⌘+` / `⌘-` | zoom the whole UI in/out (`⌘0` resets; persists across launches) |

## Hiding

Not everything in a list matters today. Hover any task or note and click **◐** to
hide it — forever, or for a day / week / month. Hidden rows leave the list
entirely (no faded clutter) until you toggle them back in:

- **⌘P → Show Hidden Tasks / Show Hidden Notes** — two independent toggles.
  When on, hidden entries render inline where they live: dimmed, marked **◐**
  with the hide's expiry, hover actions reduced to unhide (↺) and delete. The
  header's **◐** icon toggles both at once.
- All the Show/Hide toggles (these, Goals, Notes, the Today / Daily / Backlog
  sections, and the Priority tiers) persist across launches.
- **⌘P → Show Default View** is the universal reset: hidden entries excluded,
  filters cleared, all sections + Notes shown — and Goals hidden, restoring
  the plain task list.

Time-limited hides auto-restore: `hidden_until` is an ISO date, and the same
midnight sweep that drops Today items into Backlog also clears any expired hide,
so nothing needs a timer. Hiding is **not** logged to the journal — it's
housekeeping, not activity.

## Projects

Projects are a second organising axis alongside the three sections. Hover any
item and click **#** to assign it to a project (or clear it), or type a name and
press Enter to create a new one. Each item shows its project as a small,
**color-coded** label on the far right of the row — the color is stable per
project, so you can group items across sections at a glance. The label (and the
item's priority bars) stay visible on hover, alongside the row's action
buttons.

You can also assign a project right from the capture field: end the text with a
`#tag` and it links to the project. Matching is case-insensitive by exact name
or a unique prefix (`#day` → "dayapp"). If the tag matches **no** existing
project, a new one is created from it — but only when the tag is the last thing
typed (`fix bug #acme` creates "acme"; `fix bug #acme notes` does not). The tag
is stripped from the row once linked. (Tags compose with `!1..3` priority and
`@` agent tokens — see [Priorities](#priorities) and
[Delegating to the agent](#delegating-to-the-agent).)

To focus on one project's work, press **⌘F and type `#`**: the search list
becomes your projects (keep typing after the `#` to narrow it), each shown with
its color dot. Pick one — ↑/↓ + Enter or a click — and the main list shows only
that project's tasks. The filtered project is marked **filtered** in the list;
picking it again clears the filter, as does **⌘P → Show Default View**. The
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

Today and Daily rows show the tier as three small **signal bars** on the right —
`▮▮▮` = priority 1, `▮▮▯` = 2, `▮▯▯` = 3 — more filled bars means more urgent.
The **Backlog is sorted by priority** — tier 1 first, no priority last, manual
drag order within a tier — and its rows carry no bars: every tier group is
introduced by a hairline divider labeled with the group's bars (the
unprioritized group's label is an empty track), so the groups read
structurally, no divider can be mistaken for the capture input, and a drag
across a divider snapping back to its tier is visible, not surprising. A
Backlog whose items all share one tier renders undivided.

**⌘P → Show/Hide Priority 1/2/3** are three independent toggles: each hides
(or shows) just that tier's rows, leaving the other tiers and unmarked tasks
alone (each command's hint shows its bars; the toggles persist across
launches). **Show Default View** clears them all. Priorities are
housekeeping, like projects: not logged to the journal.

## Delegating to the agent

Every task answers *what* and *when* — sections, reminders, priorities. The
`@` token adds the one missing axis: **who executes**. End a task's text with
a bare `@` ("refactor the parser @") to mark it as fully delegable to an AI
agent — the token is stripped and the row grows a small **robot badge** in its
metadata (before the priority bars, visible in every section, kept on hover).
`@0` on a later edit takes the task back; editing without a token leaves the
assignment alone. The token composes with `#tag` and `!N` in any order, and
`@word` stays literal, so "ping @bob" is never eaten. Assignment is
housekeeping — not logged to the journal.

The point is triage and dispatch:

- **Details are the prompt.** A one-line title isn't enough for an agent to execute
  well. Hover the row's **⋯** button (it reads **⌄** — expand — once details exist),
  or press **`d`** on the selected row, to open the task's body: a full-width,
  full-strength writing surface under the row — the expanded task reads as a small
  document (headline + body), not an attachment. Context, constraints, definition
  of done. It autosaves like Notes and is **not**
  logged to the journal (content, not activity). `dayapp --task <query>` prints the
  task plus its details, so an automation — or any agent session — reads the spec
  straight from the CLI.
- **⌘F → `@`** flips the search to the executor picker: **🤖 Agent tasks**
  narrows the list to the agent's queue, **My tasks** to your own (picking the
  active one clears it — same toggle rule as the project filter; session-only,
  composes with the priority tiers and project filter).
- **⌘P → Show/Hide Agent Tasks** hides the 🤖 rows entirely (persisted) — the
  focus view for "what's actually mine". **Show Default View** shows them again.
- **`dayapp --list`** marks agent rows with **🤖**, so an agent session (or you
  over SSH) can see which tasks are theirs to take at a glance.

## Goals

Goals are the identity layer — statements of direction at three horizons, the
top of the app's timescale stack (timers track seconds, items track days,
goals span months → never). The section renders at the very top of the main
page, above Notes, grouped in reading order:

- **Timeless** — a direction, never done ("be a better person"). These rows
  show ∞ instead of a checkbox: a timeless goal can't be achieved, only
  revised (click to edit) or deleted.
- **Long term** — years ("become a better entrepreneur").
- **Short term** — months ("get a job"). The default horizon: a plain capture
  lands here.

Capture takes a leading horizon word — `timeless be a better person`,
`long better entrepreneur #hustle` (the `#tag` project link works exactly like
item capture). The same parse applies on edit: a horizon word moves the goal
between groups, no word leaves the tier alone. Goals link to projects
optionally (hover **#**), showing the same color-coded label as items.

Checking a short/long goal marks it **achieved** — it moves to a dim
"Achieved" group at the bottom carrying its month ("Aug 2026"), and clicking
the checkbox undoes it. Achievements are kept, never swept.

**⌘P → Show/Hide Goals** toggles the whole section off and on (persisted
across launches; **Show Default View** hides it — the default working view is
the plain task list). Goals are logged to the journal like items — every
set / achieve / reopen / edit / drop shows up in the Journal view, which also
has a **Goals** filter pill for the identity-layer narrative. The project link
stays housekeeping, unlogged. `dayapp --goals` prints the current list grouped
by horizon (below) — the agent-context view.

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

## Mobile (Android)

The phone is a **read-only mirror + capture inbox** over a private GitHub repo
(e.g. `faraz-35/dayapp-sync`) — GitHub is the always-up transport, and the Mac
stays the single writer of the database. There is no server to run and no
device-to-device sync.

```
Mac app ──(tasks.json export, every minute when changed + ⌘P on demand)──▶ private repo
Phone   ──(fetch tasks.json; appends captures to captures.json)──────────▶ same repo
Mac app ──(pull captures.json, ingest each as a real item)◀──────────────┘
```

- **Deploy** exports the task list to `tasks.json`. A background loop pushes it
  once a minute whenever it changed (so CLI writes reach the phone too), and
  ⌘P → **Mobile: Deploy Task List Now** force-pushes.
- **Capture from the phone**: type in the bottom bar (Today/Backlog toggle),
  hit ↵. Captures queue in `captures.json` and appear in the app within a
  minute of it being open — through the normal create path, so `#tag` and
  `!1..3` tokens work from the phone too. ⌘P → **Mobile: Pull Captures Now**
  drains the inbox immediately; a pull also runs on launch and every minute.
  Captures made while the Mac is closed wait in the inbox (shown dimmed under
  "Queued" on the phone) and land on the next open.
- The phone renders day rollovers itself (daily grey-out, done-today
  retirement are render-time date comparisons), so a stale export still looks
  right after midnight. The last fetched list stays on screen offline.

**Setup (one time):**

1. ⌘P → **Mobile: Configure Sync…** — set the repo (`owner/name`) and branch.
   Leave the token empty and the desktop uses your `gh auth token` (zero
   config on the Mac).
2. On github.com → Settings → Developer settings → **Fine-grained tokens**,
   create a token with **Contents: read & write** scoped to *only* the sync
   repo. The phone needs it (it can't reach your keyring).
3. Install the APK — no sign-in needed: download it from
   [faraz-35/dayapp-mobile releases](https://github.com/faraz-35/dayapp-mobile/releases/latest)
   (a public distribution repo; the app holds no secrets). Open it once and
   paste repo + token. Done.

**APK:** `npm run tauri android build -- --target aarch64 --apk` (needs
Android SDK + NDK + JDK 17+). The build emits an **unsigned** APK under
`src-tauri/gen/android/app/build/outputs/apk/universal/release/`; sign it with
the debug keystore before shipping:

```bash
~/Library/Android/sdk/build-tools/*/apksigner sign \
  --ks ~/.android/debug.keystore --ks-pass pass:android \
  --ks-key-alias androiddebugkey --key-pass pass:android <apk>
```

Distribute it as a Release on the public
[`faraz-35/dayapp-mobile`](https://github.com/faraz-35/dayapp-mobile)
repo (authless download) — keep signing with that same keystore so updates
install over the top (compare `apksigner verify --print-certs` SHA-256 against
the previous release if in doubt).

## Remote access (SSH / zcode)

The same binary is a tiny CLI for checking and triggering tasks from a remote
session — it opens the same db (WAL + busy-timeout make the two processes
safe together) and force-deploys after writes so the phone sees them fast.
The read flags mirror the GUI's surfaces (⌘F, the journal, the sections), so
a remote session can access any information the app can show, and the write
flags close the delegation loop: claim a 🤖 task (`--move` it to Today), work
it, write the outcome back (`--details`), complete it.

```bash
dayapp --list [today|daily|backlog] [--hidden]   # tasks (▶ timer, ✓ done, ◐ hidden, 🤖 agent, #name project)
dayapp --task "PSX stock algo"        # one task in full, incl. its details (the agent prompt)
dayapp --search "outreach"            # ⌘F: text substring
dayapp --search "#job"                #   or a project's rows (bare # lists projects)
dayapp --search "@agent"              #   or the delegation axis (@agent / @my)
dayapp --journal [week]               # the journal: actions + per-task time by day
                                      #   (today | week | month | all | YYYY-MM-DD)
dayapp --notes [query] [--hidden]     # notes, optionally filtered by body substring
dayapp --projects                     # projects as #tags
dayapp --add "call bank #money !1" --to backlog   # note: text is stored raw (no token parsing here)
dayapp --complete "call bank"         # id prefix or unique text substring
dayapp --start "ship mobile build"    # start the single active timer
dayapp --move "call bank" --to today  # move between sections (appends at the end)
dayapp --details "call bank" "..."    # replace the details body — the agent prompt ("" clears)
dayapp --goals                        # print goals grouped by horizon (achieved last)
dayapp --deploy                       # force-push tasks.json now
dayapp --sync-pull-peek               # peek at the phone's pending captures
```

## Not yet built (intentional)

- Global hotkey to toggle the window (Phase 2)
- Menu bar presence (Phase 2)
- Undo toast on destructive ops (Phase 1)
- Agent query tool — read-only bridge for external skills to query the DB (Phase 3)
- Completing/editing tasks from the phone (mobile stays capture + read; interactive
  mobile is the hosted-API tier, see AGENTS.md)

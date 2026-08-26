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
| "What I did this week" | `SELECT FROM actions WHERE action='completed'` — the log writes itself on every mutation; the Analytics page summarizes it, `--journal` prints it |
| "How long I worked on X" | `SELECT SUM(duration_secs) FROM sessions WHERE item_id=X` — ▶/⏸ write open/close timestamps; the Analytics day ledger totals them, `--journal` breaks them down per task |
| Hide tasks/notes for a while | `hidden=1` + optional `hidden_until` date; `list_*` filters `hidden=0`. The midnight sweep clears expired hides, so "hide for a day/week/month" auto-restores with no cron |

Every action (create/complete/move/edit/delete/sweep) is appended to `actions`. That log
is the spine of the **Analytics** page (top-right `≡`) — see below.

## Analytics

The `≡` view is a dashboard synthesized from the log — it answers questions, it never
enumerates events. Scoped to Today/Week/Month/All (default **Week**) or any picked day,
and optionally narrowed by the **axis filters** on the toolbar's right end: a `#` project
picker (multi-select, "No project" included) and priority tier chips — the whole page
(stats, heatmap, splits, ledger) derives over the selected axes, reading the same
write-time snapshots the splits do. A split card whose axis is filtered hides (the
filtered view already answers it); tracked time doesn't follow the filter (the ledger
hides its day total while filtered — per-task time rides the filtered task rows):

- **Stats** — done (effective completions: an unchecked-never-redone task doesn't count,
  a re-completed misclick counts once), avg/day, streak (consecutive days with ≥1
  completion; a live today with nothing yet doesn't break it), **daily missed** (habits
  the day ended without) and **today missed** (tasks that fell to Backlog unfinished —
  the sweep logs those for free).
- **Activity** — the current month as a calendar heatmap, in the app's single accent.
  Click any day to open it.
- **Projects / Priority splits** — every project's share of the range's completions
  (zeros visible, so neglected projects read too) and the priority tiers you actually
  clear, as one segmented bar. Both read project/priority snapshotted onto each
  `actions` row at write time, so the splits are real history — reassigning a task never
  rewrites the past.
- **Days ledger** — one line per day that had any signal (`MON, AUG 24 · 7 done · 1
  missed`). Click a day — here or on the heatmap — and it expands to what actually
  happened: each task completed (with its time and tracked time), what fell to Backlog,
  which habits were missed.

The page is a stack of elevated cards, and it's responsive: the 480px window stacks
them; fullscreened on a laptop they lay out as a proper dashboard — the stats card
across the top, Activity · Projects · Priority in one row, the day ledger on its own
row below. The raw action log's
textual home is `dayapp --journal`: the same summary block, then every action grouped
by day. Time appears only as the ledger's per-day total (and per-task in an expanded
day) when any was tracked — sessions stay a separate dimension, not dashboard stats.

## Journal & quotes (##j / ##q)

The notes capture bar is a **typed bus**: plain text becomes a note, and a leading token
reroutes the line into a different kind of content — stored in its own table, displayed
on its own surface:

- `##j` — a **journal entry**. One line of reflection, stamped with its day. The `¶` view
  (top-right, or ⌘P → View Journal) renders them as days newest-first, entries in capture
  order — the written journal, next to Analytics' computed one. Its capture line adds
  entries directly (plain text = today's entry; `##q` still routes to quotes from there),
  single-click edits inline, hover reveals delete.
- `##q` — a **quote**. It joins the pool behind the quote moment: ⌘P → **Show a Quote**
  puts one quote on a dim backdrop — serif italic, centered, nothing else — for a quiet
  pause. Any key or click dismisses it, or it goes on its own after ~45 seconds; it never
  shows the same quote twice in a row. The entry hides while the pool is empty. That modal
  is a quote's only surface — there's no management list anywhere (yet); `##q` captures
  just join the pool.
- The modal also doubles as a **screensaver**: after 2 minutes with no input while the
  app is focused — reading and thinking count as no input; time spent in another app
  doesn't count toward it — a quote appears and stays until any key or click. ⌘P →
  **Enable/Disable Quote Screensaver** turns it off (default on; hides with an empty pool).

The `##` prefix is reserved so it can't collide with the `#tag` project token. Entries
have no priority/project/hide axes — just text and its day — and like notes they're
content, never logged to `actions` and never exported to the phone.

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

The build targets the `.app` bundle only (`tauri.conf.json` sets `"targets": ["app"]`) —
no `.dmg`, no installer screen. To install or update `/Applications/DayApp.app`, use
**⌘P → Update DayApp** from inside the app or `npm run update` from the repo (both are
the next section).

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
Today / Daily / Backlog, Hidden Tasks, Hidden Notes, Priority 1/2/3 Tasks, Priority 1/2/3 Notes,
Agent Tasks — **Enter/Exit Focus Mode** (the deep-work lens: P1 notes + Today + Daily +
P1 Backlog only),
Enter/Exit Demo Mode + Reset Demo Data, the mobile sync commands (Deploy Task List Now /
Pull Captures Now / Configure Sync…), View Analytics, View Journal, Show a Quote +
Enable/Disable Quote Screensaver,
Keyboard Shortcuts
(the focus-grammar reference card), and Update DayApp. Trivially extensible — add a
command to the registry in `App.tsx`.

## Where things live

```
dayapp/
├── src/
│   ├── App.tsx              ← shell: state, effects, the focus grammar key handler, header, view switching
│   ├── lib.ts               ← typed Tauri invoke wrappers + types + date/color helpers
│   ├── focusNav.ts          ← the grammar's DOM side: digit dispatch to data-kb buttons
│   ├── Notes.tsx            ← free-form notes (own state + API; ⌘F-in-note find, ⬇ .txt export)
│   ├── Goals.tsx            ← goals: horizon groups + capture + achieve (own state)
│   ├── Journal.tsx          ← the ##j view: day-grouped entries (quotes never render here)
│   ├── Quotes.tsx           ← the ##q moment: one quote on a dim backdrop, ⌘P-summoned or idle-screensavered
│   ├── notesApi.ts          ← notes invoke wrappers
│   ├── log.ts               ← prefixed console logger (webview side)
│   ├── HideMenu.tsx         ← shared ◐ hide-duration popover
│   ├── ProjectMenu.tsx      ← # assign/clear/create project popover
│   ├── ReminderMenu.tsx     ← ◷ reminder-date popover
│   ├── CommandPalette.tsx   ← ⌘P command palette modal
│   ├── KeyboardHelp.tsx     ← the keyboard reference card (⌘P → Keyboard Shortcuts)
│   ├── UpdateOverlay.tsx    ← self-update progress modal
│   ├── MobileView.tsx       ← Android client: read-only list + capture bar
│   ├── MobileSyncSettings.tsx ← ⌘P sync-config modal (repo/branch/token)
│   ├── components/          ← feature components (SectionList, SectionView, ItemRow,
│   │                          AnalyticsView, SearchMenu)
│   ├── main.tsx             ← React entry
│   └── index.css            ← dark Linear-flavoured theme
└── src-tauri/
    ├── src/
    │   ├── lib.rs           ← Tauri commands + setup (sweeps, reminders, sync loop on launch)
    │   ├── db.rs            ← DB layer: items, actions, sweep, hide, reminders, completions
    │   ├── notes.rs         ← notes DB logic
    │   ├── journal.rs       ← the ##j/##q typed capture: entries table (journal lines + quotes)
    │   ├── projects.rs      ← projects DB logic + item.project_id assignment
    │   ├── goals.rs         ← goals DB logic: horizons, achieve, project link
    │   ├── timers.rs        ← timer sessions: start/stop/discard/totals/per-day
    │   ├── sync.rs          ← mobile sync: tasks.json export/deploy + capture inbox pull
    │   ├── demo.rs          ← demo mode: dayapp-demo.db swap under the connection lock
    │   ├── cli.rs           ← headless CLI (--list/--task/--search/--journal/--notes/--projects/
    │   │                      --add/--complete/--start/--move/--details/--goals/--deploy/--sync-pull-peek)
    │   └── main.rs          ← binary entrypoint (GUI, or CLI when given flags)
    ├── schema.sql           ← items + actions + meta + notes + projects + goals + sessions
    ├── demo.sql             ← the demo seed (relative timestamps, embedded in the binary)
    ├── Cargo.toml
    └── tauri.conf.json
```

**Database:** `~/Library/Application Support/com.farazshah.dayapp/dayapp.db`

## Keyboard shortcuts

Power-user navigation is a **focus grammar** — ViMac-style direct addressing,
typed with no mode. Exactly one thing (a task, a note, or a goal) is focused
at a time, and digits act on whatever is focused. ⌘P → **Keyboard
Shortcuts** shows the reference card in-app.

| Keys | Action |
|---|---|
| `nn` / `nt` / `nd` / `nb` | focus the Notes / Today / Daily / Backlog capture input |
| `t1`–`t9` / `d1`–`d9` | focus a Today / Daily row |
| `b11`–`b49` | focus a Backlog row — first digit is the tier (4 = unprioritized), second the row |
| `n1`–`n9` / `g1`–`g9` | focus a note / goal |
| `1`–`6` (task) | ▶ timer (Backlog: ↑ send to Today) · # project · ◷ remind · ◐ hide · ⋯ details · × delete — on the focused row |
| `1`–`4` (note) | ⌃ expand/collapse · ⬇ download .txt · ◐ hide · × delete |
| `1`–`3` (goal) | ✓ achieve · # project · × delete |
| `e` | edit the focused thing (caret at end) |
| `Enter` | complete the focused task (on a crossed Today row: un-complete) |
| `j` / `k` | select next / previous task — with nothing focused, they (and `↑`/`↓`) scroll the list |
| `Esc` | find bar (in a note) → editing → focused → nothing — digits do nothing when nothing is focused |
| single-click | a task: select + edit; a note/goal: focus it for the digits |
| drag handle (⠿) | drag between sections |
| `⌘P` / `Ctrl+P` | command palette (update, jump to view, …) |
| `⌘F` / `Ctrl+F` | search items — floating modal, ↑/↓ + Enter to jump; a leading `#` switches it to the project filter, a leading `@` to the agent/my filter. While you're editing a note, it's a find bar **inside that note** instead |
| `⌘+` / `⌘-` | zoom the whole UI in/out (`⌘0` resets; persists across launches) |

The first key of an address (`n`/`t`/`d`/`b`/`g`) clears focus, so a digit
mid-sequence can never fire a button. Whatever is focused **shows its hover
buttons**, so the digit targets are visible on screen. With nothing focused
(after `Esc`), `j`/`k`/`↑`/`↓` scroll the page — free mode is for reading, and
its one verb is view-only. The old single-key `t`
(timer), `d` (details), and `⌫` (delete) retired — the digits `1`, `5`, and `6`
on the focused row do the same jobs.

## Search (⌘F)

**⌘F** opens a floating modal over the list: type a substring over task text, ↑/↓
through the hits, Enter (or a click) to jump — the row is selected and scrolled into
view, focused and ready for the digits. Two leading characters flip the same list
into a picker:

- **`#`** — the project filter: the hits become your projects (color dot + name; keep
  typing after the `#` to narrow). Picking one narrows the main list to that project's
  tasks; picking the already-active one clears it. Session-only, composes with the
  priority tiers (see [Projects](#projects)). The picker doubles as project
  **management**: hover a row (or ↑/↓ to it) to reveal **✎ rename** and **× delete** —
  digits `1`/`2` fire them on the active row.
- **`@`** — the executor filter: two fixed entries, **🤖 Agent tasks** and **My
  tasks**, with the same toggle rule (see
  [Delegating to the agent](#delegating-to-the-agent)).

**⌘P → Show Default View** clears either filter along with everything else.

One exception to ⌘F's scope: **while a note's textarea has focus, ⌘F finds inside
that note** — a slim bar opens on the note card itself, every match tints through
the text, Enter / ↓ and ↑ step between them (with a `n/m` count), and Esc closes
the bar and drops you back into editing with the current match selected. The
global task search owns ⌘F everywhere else. (Notes export too: the ⬇ hover
button — digit `2` on a focused note — saves the note as a `.txt` through the
native save panel, named after its first line.)

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

Renaming and deleting happen in the ⌘F `#` picker — **✎** renames in place
(every label updates instantly, since rows link by id, not name), and **×**
deletes the project. Deleting **never deletes tasks, notes or goals**: it only
removes the label (unlinks them), and clears the project filter if it was
pointing at the deleted one.

To focus on one project's work, press **⌘F and type `#`**: the search list
becomes your projects (keep typing after the `#` to narrow it), each shown with
its color dot. Pick one — ↑/↓ + Enter or a click — and the main list shows only
that project's tasks **and notes** (notes link to projects too — see
[Notes](#notes)). The filtered project is marked **filtered** in the list;
picking it again clears the filter, as does **⌘P → Show Default View**. The
filter composes with the priority tiers and lasts for the session only.

Assigning a project is housekeeping — it's **not** logged to the journal (only
completion/movement is). Deleting a project unassigns its items, goals, and
notes; the rows themselves are kept.

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

**⌘P → Show/Hide Priority 1/2/3 Tasks** are three independent toggles: each hides
(or shows) just that tier's rows, leaving the other tiers and unmarked tasks
alone (each command's hint shows its bars; the toggles persist across
launches). **Show Default View** clears them all. Priorities are
housekeeping, like projects: not logged to the journal.

## Notes

Notes are the free-form surface — auto-growing textareas with debounced
autosave, a zero-inertia capture field, per-note ⌘F find, and ⬇ `.txt` export.
They carry the same priority/project axes as tasks, generalized to multi-line
content:

- Priority and project are set with **the same token grammar as tasks**: inline
  in the capture field (`ship essay !2 #writing` — parsed and eaten, `@`
  excepted), or in an existing note by typing the tokens on their own final
  line after a blank line — when you click away, the line is caught: it
  vanishes from the body and the note moves into its tier group / gains its
  project. Tokens are never stored or displayed; a tokenless edit leaves the
  current values alone, `!0` clears the priority, and `#0` clears the project.
- Notes **group by priority exactly like the Backlog** — P1 → P3 → unmarked
  under tier dividers labeled with the group's bars, single-tier lists
  undivided. The cards themselves carry no bars; the sections are the tier
  signal.
- The collapsed card shows the note's **project label** (right-aligned, the
  same hue-per-project as task rows). An unmatched `#tag` creates its project,
  exactly like a trailing tag on a task; the matching is the same
  (case-insensitive exact or unique prefix).
- **⌘P → Show/Hide Priority 1/2/3 Notes** — the notes' own three tier toggles,
  independent of the task tiers. **⌘F's `#` project filter narrows notes too**.
- **⌘P → Enter/Exit Focus Mode** is the deep-work lens: **P1 notes, Today,
  Daily, and P1 Backlog only** (Goals hidden too). It's a lens, not a batch of
  toggle changes — exiting restores whatever your toggles were, and Show
  Default View exits it.

Like everything note-shaped, the token-set priority/project are
content + housekeeping: never logged to the journal, and not exported to the
phone (mobile is a task mirror).

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
  or press **`5`** on the focused row, to open the task's body: a full-width,
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
set / achieve / reopen / edit / drop is an `actions` row that prints in
`dayapp --journal` (the Analytics page is task analytics; goals stay off it).
The project link stays housekeeping, unlogged. `dayapp --goals` prints the
current list grouped by horizon (below) — the agent-context view.

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
the next time you open it. Pulling the item into Today yourself (drag, the
Backlog's ↑ button, `--move`) also clears the reminder — it has done its job.

## Time tracking

Each task can carry a **single global timer** — start work on one thing at a
time. Hover an item and click **▶** (or focus it and press **`1`**) to start;
the running row shows a live `H:MM:SS` in the accent colour, and a chip in the
header mirrors it so the timer survives scrolling away. Starting a timer on
another task stops the current one. Click the chip to **stop** (the session is
kept), or **×** to **discard** it (for the "left it running overnight" case).
Backlog rows have no ▶ — their slot-1 verb is **↑ send to Today**; timing
belongs to Today/Daily, where work happens.

Tracked time shows up two ways: a faint `⏱ 2h 14m` cumulative label on each row
that has any, and the Analytics day ledger's per-day total (with a per-task
breakdown in `--journal`). Time tracking is **not** logged to `actions`; sessions live
in their own `sessions` table and are layered in as a separate
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

## Demo mode

A fully interactive sample dataset for trying the app and showing it to others —
⌘P → **Enter Demo Mode** swaps the backend to a second, disposable database
(`dayapp-demo.db` next to your real one; your data is never touched). The
masthead reads **Live @ Demo** the whole time. Everything works on the sample
data — complete tasks, run timers, browse the analytics page (the seed carries a
week of history, so the heatmap, misses and splits all have data) — and mutations
persist in the demo db across sessions.

- ⌘P → **Exit Demo Mode** swaps back instantly. Demo mode is session-only:
  launching the app always opens your real db.
- ⌘P → **Reset Demo Data** (demo mode only) re-seeds the sample dataset. Seeded
  dates are relative to the reset day, so this also freshens a demo that has
  aged — run it before showing someone.
- **First run:** with no real db in place, the app opens straight into demo
  mode as a tour; "Exit Demo Mode" is the on-ramp to your empty real list.
- The phone mirror is fully gated while demo mode is active — demo tasks never
  reach `tasks.json`, and captures queue until you exit.

The seed lives in `src-tauri/demo.sql` (a founder/builder persona: today,
daily, backlog with every priority tier, notes, goals in all three horizons,
a week of actions + timer sessions). It's embedded in the binary at build
time, so it travels with the app.

## Remote access & agent context (SSH / zcode)

The same binary is a tiny CLI for checking and triggering tasks from a remote
session — it opens the same db (WAL + busy-timeout make the two processes
safe together) and force-deploys after writes so the phone sees them fast.
The read flags mirror the GUI's surfaces (⌘F, the Analytics page, the sections) and
`--journal` additionally carries the raw action log the GUI no longer shows, so
a remote session can access any information the app can show, and the write
flags close the delegation loop: claim a 🤖 task (`--move` it to Today), work
it, write the outcome back (`--details`), complete it.

```bash
dayapp --list [today|daily|backlog] [--hidden]   # tasks (▶ timer, ✓ done, ◐ hidden, 🤖 agent, #name project)
dayapp --task "PSX stock algo"        # one task in full, incl. its details (the agent prompt)
dayapp --search "outreach"            # ⌘F: text substring
dayapp --search "#job"                #   or a project's rows (bare # lists projects)
dayapp --search "@agent"              #   or the delegation axis (@agent / @my)
dayapp --journal [week]               # analytics summary + the raw action log, by day
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
dayapp --demo --list                  # any of the above against the demo db
                                      #   (writes land in dayapp-demo.db only)
```

### The 🤖 queue — agents as first-class users

The CLI is deliberately also the **agent surface**. `--list` marks delegable rows
with **🤖** (the `@` token, above), `--search '@agent'` prints just that queue, and
`--task` prints a row plus its details body — for a 🤖 row, the details **are the
prompt** (context, constraints, definition of done). The write verbs close the loop
remotely, one task per run:

1. **Claim** — `--move <query> --to today` (appends to Today)
2. **Read** — `--task <query>`
3. **Record** — `--details <query> "<approach>"` if the body was empty (never
   overwrite a non-empty body — those are Faraz's words)
4. **Done** — `--complete <query>`; the analytics page and the phone mirror pick it up
   on their own

This protocol lives in the **dayapp skill** (`~/.agents/skills/dayapp` on the Mac),
which teaches any agent session — zcode, opencode, anything that reads skills — to
fetch the live list and work the 🤖 queue. The vetting is the mark itself: a 🤖 row
is fully delegable end to end, everything unmarked is Faraz's own. The flags are
deliberately ungated (the CLI is Faraz's remote access too); the "agents touch only
their queue" discipline lives in the skill's instructions, not the binary.

## Not yet built (intentional)

- Scheduled autonomous runs over the 🤖 queue — the delegation verbs and the dayapp
  skill exist; the hourly trigger is still manual
- Completing/editing tasks from the phone (mobile stays capture + read; interactive
  mobile is the hosted-API tier, see AGENTS.md)

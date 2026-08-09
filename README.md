# DayApp

A native macOS "live today list" with auto-journaling. Not a journal app — a focused
daily-action tool whose **timestamped action log** *is* the journal, for free.

## The idea

Three sections: **Today**, **Daily**, **Backlog**. Drag between them. An item is a single
text field with a done button. Three behaviours fall out of the data model, no cron needed:

| Behaviour | How |
|---|---|
| Daily items reset overnight | `WHERE last_completed_date == today` on render — at midnight the comparison just stops being true |
| Today items fall to backlog | `run_sweep()` runs on launch (gated by `meta.last_sweep_date`); idempotent |
| "What I did this week" | `SELECT FROM actions WHERE action='completed'` — the log writes itself on every mutation |
| Hide tasks/notes for a while | `hidden=1` + optional `hidden_until` date; `list_*` filters `hidden=0`. The midnight sweep clears expired hides, so "hide for a day/week/month" auto-restores with no cron |

Every action (create/complete/move/edit/delete/sweep) is appended to `actions`. That table
powers both the journal view (top-right `≡` icon) and the "balls in the box" counter
(completions today) in the header.

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
Currently: jump to Today / Journal / Hidden, and Update DayApp. Trivially extensible — add a
command to the registry in `App.tsx`.

## Where things live

```
dayapp/
├── src/
│   ├── App.tsx              ← UI: sections, DnD, keyboard nav, journal + hidden views
│   ├── lib.ts               ← typed Tauri invoke wrappers
│   ├── Notes.tsx            ← free-form notes (own state + API)
│   ├── notesApi.ts          ← notes invoke wrappers
│   ├── HideMenu.tsx         ← shared ◐ hide-duration popover
│   ├── main.tsx             ← React entry
│   └── index.css            ← dark Linear-flavoured theme
└── src-tauri/
    ├── src/
    │   ├── lib.rs           ← Tauri commands + setup (runs sweep on launch)
    │   ├── db.rs            ← DB layer: items, actions, sweep, completions
    │   └── main.rs          ← binary entrypoint
    ├── schema.sql           ← items + actions + meta
    ├── Cargo.toml
    └── tauri.conf.json
```

**Database:** `~/Library/Application Support/com.farazshah.dayapp/dayapp.db`

## Keyboard shortcuts

| Key | Action |
|---|---|
| `j` / `↓` | select next |
| `k` / `↑` | select previous |
| `Enter` | complete selected |
| `e` | edit selected |
| `⌫` / `Delete` | delete selected |
| double-click | edit |
| drag handle (⠿) | drag between sections |
| `⌘P` / `Ctrl+P` | command palette (update, jump to view, …) |

## Hiding

Not everything in a list matters today. Hover any task or note and click **◐** to
hide it — forever, or for a day / week / month. Hidden rows leave the main list
entirely (no faded clutter) and collect in the **Hidden** view, opened from the
**◐** icon in the header. There each row can be unhidden (↺) or deleted.

Time-limited hides auto-restore: `hidden_until` is an ISO date, and the same
midnight sweep that drops Today items into Backlog also clears any expired hide,
so nothing needs a timer. Hiding is **not** logged to the journal — it's
housekeeping, not activity.

## Not yet built (intentional)

- Global hotkey to toggle the window (Phase 2)
- Menu bar presence (Phase 2)
- Undo toast on destructive ops (Phase 1)
- Agent query tool — read-only bridge for external skills to query the DB (Phase 3)
- Sync / cloud. Local SQLite only.

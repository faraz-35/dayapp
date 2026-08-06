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

## Where things live

```
dayapp/
├── src/
│   ├── App.tsx              ← UI: sections, DnD, keyboard nav, journal view
│   ├── lib.ts               ← typed Tauri invoke wrappers
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

## Not yet built (intentional)

- Global hotkey to toggle the window (Phase 2)
- Menu bar presence (Phase 2)
- Undo toast on destructive ops (Phase 1)
- Agent query tool — read-only bridge for external skills to query the DB (Phase 3)
- Sync / cloud. Local SQLite only.

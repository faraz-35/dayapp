# DayApp

A native macOS "live today list" with auto-journaling. Today, Daily, and Backlog — and every action you take is logged, so the journal writes itself.

**On the web:** [getdayapp.vercel.app](https://getdayapp.vercel.app)

<p align="center">




https://github.com/user-attachments/assets/89d471e3-f598-42df-bcbe-d255d29dccf5



https://github.com/user-attachments/assets/bea579ac-faec-4b56-811f-de2c74b11f32



https://github.com/user-attachments/assets/95b37036-ecdc-4414-a40d-0abaaff20780


</p>

<p align="center">
  <em>All shots fullscreened, in the built-in demo mode (⌘P → Enter Demo Mode).</em>
</p>

## The idea

Three sections, drag between them. Every create, complete, move, and edit appends to an `actions` log — daily resets, backlog sweeps, reminder promotions, the analytics page, and time totals are all just queries over that log. No cron, no background jobs.

The day runs 6am to 6am. Work past midnight and it's still yesterday: nothing resets, nothing falls to Backlog, and a 1am completion counts for the day you're still in.

## Analytics

A dashboard built from the log: done / streak / missed stats, a month heatmap, project and priority splits, and a day-by-day ledger — click any day (ledger row, calendar cell, or date field) to open it as its own card. Filter by project or priority. A Done / Created toggle switches what it counts — what you finished, or what you took on.

## Journal & quotes

`##j` in the capture bar writes a journal entry (rendered in the `¶` view); `##q` saves a quote. Quotes live in their own `❝` view — every capture, editable and deletable — and after two idle minutes one of them fills the screen on a dim backdrop; any key or click sends it away. The task capture routes the same way: `##t` / `##d` / `##b` send a line to Today / Daily / Backlog.

## Notes

Free-form notes with autosave, per-note find, and `.txt` export. They share the task token grammar — `!2` priority, `#tag` project — typed on the note's last line.

## Goals

Direction at three horizons: Timeless (∞, can't be achieved), Long term, Short term. Checking one stamps the month and logs it to the journal.

## Priorities & projects

`!1`–`!3` sets a priority (signal bars; the Backlog sorts by tier). `#tag` links a color-coded project and creates it if the name is new. Both strip out of the text and are never logged.

## Delegating to the agent

End a task with `@` to mark it as fully delegable — it gets a robot badge, and its details body is the agent's prompt. The CLI marks these rows 🤖, so a remote agent session can claim the task, work it, and complete it.

## Time tracking

One timer: ▶ starts, the header chip shows live elapsed, Analytics totals time per day and per task. Completing a task stops its timer.

## Reminders

Put a date on a backlog item (◷) and it moves itself to Today on launch once the date comes due. Fires once, no notification.

## Mobile (Android)

A read-only mirror + capture inbox over a private GitHub repo — the Mac stays the only writer, there is no server. Type on the phone and it lands as a task, tokens parsed. Get the APK from the [dayapp-mobile releases](https://github.com/faraz-35/dayapp-mobile/releases/latest).

## Demo mode

⌘P → Enter Demo Mode swaps to a disposable sample database, so anyone can try everything without touching your data. A first run starts on a clean, empty list — it asks your name once (for the "Live @ you" header) and Demo Mode is always a ⌘P away.

## Keyboard

One thing is focused at a time, and the digits act on it: `t1` focuses a Today row, `b31` a P3 Backlog row, `1`–`6` run its buttons. `j`/`k` move, `e` edits, `Enter` completes, `⌘F` searches (`#` by project, `@` by executor), `⌘P` opens the command palette. ⌘P → Keyboard Shortcuts shows the full card in-app.

## CLI

The same binary reads and writes the list over SSH:

```bash
dayapp --list            # tasks (🤖 marks agent-delegable rows)
dayapp --task "query"    # one task in full, its details included
dayapp --journal week    # analytics summary + the raw action log
dayapp --add "call bank #money !1" --to backlog
dayapp --complete "call bank"
```

The binary lives inside the app bundle. ⌘P → CLI: Enable installs the `dayapp` command for you: it writes a wrapper to `~/.local/bin` (pointing at the running app) and adds `~/.local/bin` to your PATH in `~/.zshrc` if it isn't there yet. New terminal windows then know `dayapp` — bare `dayapp` prints the list.

## Update

Installed from a release? A small accent icon appears at the top right of the header when a new version is out — one click downloads, verifies, and installs it. Building from source? ⌘P → Update App Locally rebuilds, swaps, and relaunches (or `npm run update`). Shipping a release: `npm run release patch` (or `minor`/`major`) publishes everything in one pass — the GitHub release, the in-app update channel, the Homebrew cask, and the site.

## Develop

```bash
npm install
npm run tauri dev      # hot-reloading dev window
npm run tauri build    # → src-tauri/target/release/bundle/macos/DayApp.app
```

Tauri 2 (Rust + native macOS window), React + TypeScript, SQLite. Architecture notes live in [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE).

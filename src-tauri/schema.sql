-- DayApp schema v1.
-- Two tables: `items` (current state) and `actions` (append-only log = the journal).
-- `meta` holds single-row settings/state like last_sweep_date.

CREATE TABLE IF NOT EXISTS items (
    id                  TEXT PRIMARY KEY,                       -- ULID
    text                TEXT NOT NULL,
    section             TEXT NOT NULL CHECK (section IN ('today','daily','backlog')),
    status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','done')),
    last_completed_date TEXT,                                    -- ISO YYYY-MM-DD; daily's reset + today's sweep retirement key off it
    sort_order          INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    -- Soft-archive: hidden=1 keeps the row but hides it from active lists.
    -- hidden_until is NULL when hidden forever, else ISO YYYY-MM-DD at which
    -- the midnight sweep clears hidden back to 0 (time-limited hide auto-restores).
    hidden              INTEGER NOT NULL DEFAULT 0,
    hidden_until        TEXT,
    -- Housekeeping columns (not logged to actions): assignment + scheduled promotion.
    project_id          TEXT,                                    -- FK→projects.id; nullable, no CASCADE enforced inline
    remind_at           TEXT,                                    -- ISO YYYY-MM-DD when a backlog item auto-promotes to today
    -- Urgency tier 1–3 (NULL = none), set via !1/!2/!3 tokens in the item text.
    -- Housekeeping like project_id — not logged. The Backlog sorts by it.
    priority            INTEGER CHECK (priority IS NULL OR priority IN (1, 2, 3)),
    -- Delegation axis: 1 = the task is fully delegable to an AI agent (set via a
    -- bare `@` token in the item text; `@0` clears). Housekeeping like priority —
    -- not logged. Unmarked (0) = Faraz's own. The list/CLI/⌘F filter off it.
    assigned_to_agent   INTEGER NOT NULL DEFAULT 0 CHECK (assigned_to_agent IN (0, 1)),
    -- Free-form body under the one-line title — the task's spec/context, and
    -- for agent-delegated rows the prompt an autonomous session executes
    -- (readable via `dayapp --task`). Content like notes, not state: edits are
    -- housekeeping — not logged — and it stays out of the phone export.
    details             TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_items_section ON items(section, sort_order);
CREATE INDEX IF NOT EXISTS idx_items_status  ON items(status);
-- `hidden` is deliberately NOT indexed: it's a low-cardinality boolean
-- (almost all rows are 0), so SQLite would never pick such an index, and
-- creating it here would fail on databases that predate the column (the
-- ensure_column migration runs after this batch). The WHERE hidden = 0
-- filter is cheap on a personal-scale table.

-- Append-only. item_text is snapshotted at write time so history survives edits/deletes.
-- v2: goals log here too. Item rows set item_id; goal rows set goal_id — exactly
-- one of the two (CHECK). Goal rows reuse the section columns for the horizon and
-- the status columns for active/achieved, so the journal renders both uniformly.
-- DBs created before v2 are rebuilt once in db.rs migrate() (SQLite can't ALTER
-- a CHECK constraint or a NOT NULL).
CREATE TABLE IF NOT EXISTS actions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id      TEXT,                                    -- FK→items.id; NULL on goal rows
    goal_id      TEXT,                                    -- FK→goals.id; NULL on item rows
    item_text    TEXT NOT NULL,                           -- subject text snapshot (item or goal)
    action       TEXT NOT NULL CHECK (action IN
                  ('created','completed','uncompleted','moved',
                   'edited','deleted','fell_to_backlog',
                   'goal_created','goal_achieved','goal_unachieved',
                   'goal_edited','goal_deleted')),
    from_section TEXT, to_section TEXT,
    from_status  TEXT, to_status  TEXT,
    timestamp    TEXT NOT NULL,
    CHECK (item_id IS NOT NULL OR goal_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_actions_ts      ON actions(timestamp);
CREATE INDEX IF NOT EXISTS idx_actions_item    ON actions(item_id);
CREATE INDEX IF NOT EXISTS idx_actions_action  ON actions(action);
CREATE INDEX IF NOT EXISTS idx_actions_goal    ON actions(goal_id);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Notes: free-form multiline text (quotes, scratch, anything). Deliberately NOT
-- logged in `actions` — notes are content, not activity. Independent of the
-- items/actions lifecycle.
--
-- priority + project_id are the same axes items carry, set with the same token
-- grammar (`!1..3` / `#tag`): inline at capture, or a blank line + tokens-only
-- final line in an existing note, caught on blur. Tokens are input syntax —
-- never stored in the body (it stays pure prose); the columns are set through
-- `set_note_priority`/`set_note_project` exactly like the item setters, and
-- nothing here is logged. Notes group by priority the way the Backlog does
-- (tier sections P1 → P3 → unmarked); the project link shares the projects
-- table, and deleting a project nulls it here too. One migration in db.rs
-- consumed token lines an earlier footer-storing build wrote into bodies.
CREATE TABLE IF NOT EXISTS notes (
    id           TEXT PRIMARY KEY,                       -- ULID
    body         TEXT NOT NULL DEFAULT '',
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    hidden       INTEGER NOT NULL DEFAULT 0,
    hidden_until TEXT,
    priority     INTEGER CHECK (priority IS NULL OR priority IN (1, 2, 3)),
    project_id   TEXT                                    -- FK→projects.id; nullable, no CASCADE enforced inline
);

CREATE INDEX IF NOT EXISTS idx_notes_order ON notes(sort_order);
-- `hidden` intentionally unindexed on notes too; see comment on items table.

-- Projects: a second organising axis alongside Sections. Assigning an item to a
-- project is housekeeping (like hide), so it is NOT logged to `actions` — the
-- journal stays focused on completion/movement. items.project_id (added via the
-- ensure_column migration) is nullable; deleting a project nulls it (items kept).
CREATE TABLE IF NOT EXISTS projects (
    id         TEXT PRIMARY KEY,                          -- ULID
    name       TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_order ON projects(sort_order, created_at);

-- Goals: the identity layer above the task sections — statements of direction
-- at three horizons: short (months, completable), long (years, completable),
-- timeless (a direction, never achieved — only revised or deleted). The timescale
-- stack tops out here: timers (seconds) → items (days) → goals (months → never).
-- Goals give the daily list its "why" and are prime agent context. Like items,
-- they are state + logged activity: every create/achieve/unachieve/edit/delete
-- appends to `actions` (goal_* values; horizon rides from/to_section,
-- active/achieved rides from/to_status). Project assignment is housekeeping —
-- NOT logged, same as items.project_id. project_id is the optional link to a
-- project (nullable, no CASCADE enforced inline; deleting a project nulls it).
CREATE TABLE IF NOT EXISTS goals (
    id          TEXT PRIMARY KEY,                          -- ULID
    text        TEXT NOT NULL,
    horizon     TEXT NOT NULL CHECK (horizon IN ('short','long','timeless')),
    status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','achieved')),
    project_id  TEXT,                                      -- FK→projects.id
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    achieved_at TEXT                                        -- NULL unless status='achieved'
);

CREATE INDEX IF NOT EXISTS idx_goals_order ON goals(sort_order, created_at);

-- Timer sessions: per-task time tracking. A session is an interval of focused
-- work on one item: ▶ opens a row (ended_at NULL), ⏸ fills ended_at +
-- duration_secs. Exactly one row may be open at a time (the single active
-- timer) — `start_timer` enforces this by finalizing any open session first, so
-- the open-row invariant is maintained in code (no DB-level unique constraint).
--
-- Sessions are *measurement* (content), not item-state transitions, so — like
-- notes/projects — they are NOT logged to `actions`. The journal surfaces time
-- as a separate dimension via `session_time_by_day`. `item_text` is snapshotted
-- at write time so history survives edits/deletes, mirroring actions.item_text.
CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,                     -- ULID
    item_id       TEXT NOT NULL,
    item_text     TEXT NOT NULL,                        -- snapshot at write time
    started_at    TEXT NOT NULL,                        -- local ISO timestamp (from now_iso)
    ended_at      TEXT,                                 -- NULL while the session is open
    duration_secs INTEGER                                -- NULL while open; set when ended_at is written
);

CREATE INDEX IF NOT EXISTS idx_sessions_item  ON sessions(item_id);
CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions(started_at);
-- A partial index over the (at most one) open row makes get_active_timer /
-- time_totals lookups cheap and keeps the "one open session" invariant visible.
CREATE INDEX IF NOT EXISTS idx_sessions_open  ON sessions(id) WHERE ended_at IS NULL;

-- DayApp schema v1.
-- Two tables: `items` (current state) and `actions` (append-only log = the journal).
-- `meta` holds single-row settings/state like last_sweep_date.

CREATE TABLE IF NOT EXISTS items (
    id                  TEXT PRIMARY KEY,                       -- ULID
    text                TEXT NOT NULL,
    section             TEXT NOT NULL CHECK (section IN ('today','daily','backlog')),
    status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','done')),
    last_completed_date TEXT,                                    -- ISO YYYY-MM-DD; only daily uses it
    sort_order          INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_section ON items(section, sort_order);
CREATE INDEX IF NOT EXISTS idx_items_status  ON items(status);

-- Append-only. item_text is snapshotted at write time so history survives edits/deletes.
CREATE TABLE IF NOT EXISTS actions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id      TEXT NOT NULL,
    item_text    TEXT NOT NULL,
    action       TEXT NOT NULL CHECK (action IN
                  ('created','completed','uncompleted','moved',
                   'edited','deleted','fell_to_backlog')),
    from_section TEXT, to_section TEXT,
    from_status  TEXT, to_status  TEXT,
    timestamp    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_actions_ts      ON actions(timestamp);
CREATE INDEX IF NOT EXISTS idx_actions_item    ON actions(item_id);
CREATE INDEX IF NOT EXISTS idx_actions_action  ON actions(action);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- DayApp demo seed — the sample dataset behind ⌘P → "Enter Demo Mode" (and the
-- first-run tour). Deliberately small: the first minute is the product, so one
-- row per surface and plain everyday texts — a daily habit done for today, a
-- backlog row shelved with a reminder, a note. Today is empty on purpose: the
-- capture bar with its rotating hints is the first act.
--
-- The rows still carry their axes — the backlog row holds a priority, a
-- pending reminder, and a project link — dormant while their Settings switches
-- are off (the factory defaults), and in action the moment one is flipped on.
-- What was cut is count, not capability.
--
-- Every timestamp is computed relative to the moment the seed runs (SQLite
-- date modifiers, each shifted −6 hours onto the app's 6am→6am logical day),
-- so the done-today daily, its 4-day streak, and the pending reminder demo
-- correctly no matter when the seed was planted or re-planted.
--
-- This file is content, not schema: schema.sql runs at open (same as the real
-- db), and this script wipes every table before inserting — so "Reset Demo
-- Data" is simply running it again. It is embedded in the binary at compile
-- time (include_str!) and travels with the app; git tracks it for reviewable
-- history. The generated file lives in app support as dayapp-demo.db.
--
-- The history is self-consistent: actions insert in chronological order
-- (id order = journal display order), and the daily's created row anchors the
-- dashboard's daily-miss replay — four days alive, four days done, no misses.

BEGIN;

DELETE FROM actions;
DELETE FROM items;
DELETE FROM goals;
DELETE FROM notes;
DELETE FROM projects;
DELETE FROM sessions;
DELETE FROM entries;
DELETE FROM meta;

-- The day-boundary gate: seeded "today" is today, so the sweep must not run
-- the moment demo mode opens. No sync keys — demo data never reaches the
-- phone (deploy/pull are gated while demo is on).

INSERT INTO meta (key, value) VALUES
  ('last_sweep_date', date('now','localtime','-6 hours'));

-- ---- Projects ------------------------------------------------------------
-- One link, one visible label: the backlog row wears it on the far right.

INSERT INTO projects (id, name, sort_order, created_at) VALUES
  ('demo-p-home', 'Home', 0, date('now','localtime','-6 hours','-9 days') || 'T10:00:00');

-- ---- Items -----------------------------------------------------------------
-- The daily is done for today (last_completed_date = today → greyed until
-- tomorrow, the daily reset in action). The backlog row waits with a reminder
-- (+3 days) and a priority tier — both dormant until their switches turn on.

INSERT INTO items (id, text, section, status, last_completed_date, sort_order, created_at, updated_at, hidden, hidden_until, project_id, remind_at, priority, assigned_to_agent, details) VALUES
  ('demo-d-plants', 'Water the plants',
   'daily', 'active', date('now','localtime','-6 hours'), 0,
   date('now','localtime','-6 hours','-4 days') || 'T07:00:00',
   date('now','localtime','-6 hours') || 'T07:30:00', 0, NULL, NULL, NULL, NULL, 0, ''),
  ('demo-b-dentist', 'Book dentist appointment',
   'backlog', 'active', NULL, 0,
   date('now','localtime','-6 hours','-2 days') || 'T11:00:00',
   date('now','localtime','-6 hours','-2 days') || 'T11:00:00', 0, NULL, 'demo-p-home', date('now','localtime','-6 hours','+3 days'), 2, 0, '');

-- ---- Notes -----------------------------------------------------------------
-- One note, plain prose — the lowest-friction surface with something in it.

INSERT INTO notes (id, body, sort_order, created_at, updated_at, hidden, hidden_until, priority, project_id) VALUES
  ('demo-n-groceries',
   'Groceries
- oats
- bananas
- coffee',
   0,
   date('now','localtime','-6 hours','-1 days') || 'T18:05:00',
   date('now','localtime','-6 hours','-1 days') || 'T18:05:00', 0, NULL, NULL, NULL);

-- ---- Actions -----------------------------------------------------------------
-- The daily's short life, in strict chronological order (id order = the
-- journal's display order): created four days ago, done every day since —
-- the streak and the analytics day-ledger read true.

INSERT INTO actions (item_id, goal_id, item_text, action, from_section, to_section, from_status, to_status, timestamp) VALUES
  ('demo-d-plants', NULL, 'Water the plants', 'created', NULL, 'daily', NULL, 'active',
   date('now','localtime','-6 hours','-4 days') || 'T07:00:00'),
  ('demo-d-plants', NULL, 'Water the plants', 'completed', 'daily', 'daily', 'active', 'active',
   date('now','localtime','-6 hours','-3 days') || 'T09:12:00'),
  ('demo-d-plants', NULL, 'Water the plants', 'completed', 'daily', 'daily', 'active', 'active',
   date('now','localtime','-6 hours','-2 days') || 'T08:40:00'),
  ('demo-b-dentist', NULL, 'Book dentist appointment', 'created', NULL, 'backlog', NULL, 'active',
   date('now','localtime','-6 hours','-2 days') || 'T11:00:00'),
  ('demo-d-plants', NULL, 'Water the plants', 'completed', 'daily', 'daily', 'active', 'active',
   date('now','localtime','-6 hours','-1 days') || 'T09:20:00'),
  ('demo-d-plants', NULL, 'Water the plants', 'completed', 'daily', 'daily', 'active', 'active',
   date('now','localtime','-6 hours') || 'T07:30:00');

COMMIT;

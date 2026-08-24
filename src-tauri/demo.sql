-- DayApp demo seed — the sample dataset behind ⌘P → "Enter Demo Mode" (and the
-- first-run tour). One persona: a founder/builder/software engineer growing a
-- small SaaS ("meridian"). Every timestamp is computed relative to the moment
-- the seed runs (SQLite date modifiers), so the journal's week of history, the
-- done-today row, the greyed daily, and the pending reminder all demo correctly
-- no matter when the seed was planted or re-planted.
--
-- This file is content, not schema: schema.sql runs at open (same as the real
-- db), and this script wipes every table before inserting — so "Reset Demo
-- Data" is simply running it again. It is embedded in the binary at compile
-- time (include_str!) and travels with the app; git tracks it for reviewable
-- history. The generated file lives in app support as dayapp-demo.db.
--
-- The history is self-consistent: rows are inserted in chronological order
-- (actions.id order = journal display order), every live item's arc matches
-- its current state, and history-only rows (demo-x-*) exist only in actions —
-- done-today rows retired by the sweep and deleted rows whose snapshots
-- outlive them, exactly like a real db.

BEGIN;

DELETE FROM actions;
DELETE FROM items;
DELETE FROM goals;
DELETE FROM notes;
DELETE FROM projects;
DELETE FROM sessions;
DELETE FROM meta;

-- The day-boundary gate: seeded "today" is today, so the sweep must not run
-- the moment demo mode opens and scatter the curated Today list. No sync keys
-- — demo data never reaches the phone (deploy/pull are gated while demo is on).

INSERT INTO meta (key, value) VALUES
  ('last_sweep_date', date('now', 'localtime'));

-- ---- Projects --------------------------------------------------------------
-- meridian = the product, growth = getting users, health = the operator.

INSERT INTO projects (id, name, sort_order, created_at) VALUES
  ('demo-p-meridian', 'meridian', 0, date('now','localtime','-30 days') || 'T09:00:00'),
  ('demo-p-growth',   'growth',   1, date('now','localtime','-30 days') || 'T09:00:00'),
  ('demo-p-health',   'health',   2, date('now','localtime','-20 days') || 'T09:00:00');

-- ---- Goals -------------------------------------------------------------------
-- One per horizon plus one achieved, so every group of the identity layer shows.

INSERT INTO goals (id, text, horizon, status, project_id, sort_order, created_at, updated_at, achieved_at) VALUES
  ('demo-g-timeless', 'Build software people genuinely love using',
   'timeless', 'active', NULL, 0,
   date('now','localtime','-30 days') || 'T21:30:00',
   date('now','localtime','-30 days') || 'T21:30:00', NULL),
  ('demo-g-long', 'Grow meridian into a profitable one-person business',
   'long', 'active', 'demo-p-meridian', 0,
   date('now','localtime','-30 days') || 'T21:35:00',
   date('now','localtime','-30 days') || 'T21:35:00', NULL),
  ('demo-g-beta', 'Ship the mobile beta to 100 users',
   'short', 'active', 'demo-p-meridian', 0,
   date('now','localtime','-6 days') || 'T08:40:00',
   date('now','localtime','-6 days') || 'T08:40:00', NULL),
  ('demo-g-waitlist', 'Launch the public waitlist page',
   'short', 'achieved', 'demo-p-growth', 1,
   date('now','localtime','-15 days') || 'T10:00:00',
   date('now','localtime','-8 days') || 'T16:20:00',
   date('now','localtime','-8 days') || 'T16:20:00');

-- ---- Items: Today ------------------------------------------------------------
-- A believable morning: one done (crossed, done-today), one agent-delegated
-- with its prompt in details, a P1, a P2, and the gym.

INSERT INTO items (id, text, section, status, last_completed_date, sort_order, created_at, updated_at, hidden, hidden_until, project_id, remind_at, priority, assigned_to_agent, details) VALUES
  ('demo-t-pr', 'Review PR #214 — search ranking tweak',
   'today', 'active', NULL, 0,
   date('now','localtime','-2 days') || 'T11:12:00',
   date('now','localtime','-1 days') || 'T09:05:00', 0, NULL, 'demo-p-meridian', NULL, 2, 0, ''),
  ('demo-t-crash', 'Fix crash on first-launch onboarding',
   'today', 'done', date('now','localtime'), 1,
   date('now','localtime','-1 days') || 'T08:55:00',
   date('now','localtime') || 'T09:41:00', 0, NULL, 'demo-p-meridian', NULL, 1, 0, ''),
  ('demo-t-investor', 'Draft monthly investor update',
   'today', 'active', NULL, 2,
   date('now','localtime') || 'T08:15:00',
   date('now','localtime') || 'T08:15:00', 0, NULL, 'demo-p-growth', NULL, NULL, 0, ''),
  ('demo-t-interviews', 'Compile user interview insights',
   'today', 'active', NULL, 3,
   date('now','localtime','-2 days') || 'T16:45:00',
   date('now','localtime','-1 days') || 'T09:20:00', 0, NULL, 'demo-p-growth', NULL, NULL, 1,
   'Read the six interview transcripts in the shared Research doc. Pull out: (1) recurring onboarding pain points, (2) quotes explaining why users churn before the first aha moment, (3) any feature request mentioned by three or more people. Write the summary as a note titled "Interview synthesis" and drop the link in the growth channel.'),
  ('demo-t-gym', 'Gym — push day',
   'today', 'active', NULL, 4,
   date('now','localtime','-4 days') || 'T07:30:00',
   date('now','localtime','-1 days') || 'T09:25:00', 0, NULL, 'demo-p-health', NULL, NULL, 0, '');

-- ---- Items: Daily ------------------------------------------------------------
-- The walk is done for today (last_completed_date = today → greyed until
-- tomorrow, the daily reset in action).

INSERT INTO items (id, text, section, status, last_completed_date, sort_order, created_at, updated_at, hidden, hidden_until, project_id, remind_at, priority, assigned_to_agent, details) VALUES
  ('demo-d-deepwork', 'Morning deep work block',
   'daily', 'active', NULL, 0,
   date('now','localtime','-20 days') || 'T07:00:00',
   date('now','localtime','-20 days') || 'T07:00:00', 0, NULL, NULL, NULL, NULL, 0, ''),
  ('demo-d-read', 'Read 20 pages',
   'daily', 'active', NULL, 1,
   date('now','localtime','-18 days') || 'T21:00:00',
   date('now','localtime','-18 days') || 'T21:00:00', 0, NULL, NULL, NULL, NULL, 0, ''),
  ('demo-d-walk', 'Walk 8k steps',
   'daily', 'active', date('now','localtime'), 2,
   date('now','localtime','-12 days') || 'T08:00:00',
   date('now','localtime') || 'T07:12:00', 0, NULL, 'demo-p-health', NULL, NULL, 0, '');

-- ---- Items: Backlog ----------------------------------------------------------
-- Every tier populated (P1/P2/unmarked), one pending reminder (+3 days), one
-- agent-delegated row with its prompt, one hidden row for the ◐ reveal.

INSERT INTO items (id, text, section, status, last_completed_date, sort_order, created_at, updated_at, hidden, hidden_until, project_id, remind_at, priority, assigned_to_agent, details) VALUES
  ('demo-b-ssl', 'Renew meridian SSL certificate',
   'backlog', 'active', NULL, 0,
   date('now','localtime','-6 days') || 'T10:00:00',
   date('now','localtime','-6 days') || 'T10:00:00', 0, NULL, 'demo-p-meridian', NULL, 1, 0, ''),
  ('demo-b-roadmap', 'Draft next quarter''s product roadmap',
   'backlog', 'active', NULL, 1,
   date('now','localtime','-5 days') || 'T15:30:00',
   date('now','localtime','-1 days') || 'T11:40:00', 0, NULL, 'demo-p-meridian', NULL, 1, 0, ''),
  ('demo-b-funnel', 'Audit onboarding funnel drop-off',
   'backlog', 'active', NULL, 2,
   date('now','localtime','-4 days') || 'T09:10:00',
   date('now','localtime','-2 days') || 'T00:01:00', 0, NULL, 'demo-p-growth', NULL, 2, 0, ''),
  ('demo-b-analytics', 'Self-host the analytics stack',
   'backlog', 'active', NULL, 3,
   date('now','localtime','-3 days') || 'T13:20:00',
   date('now','localtime','-3 days') || 'T13:20:00', 0, NULL, NULL, NULL, 2, 0, ''),
  ('demo-b-shapeup', 'Re-read Shape Up',
   'backlog', 'active', NULL, 4,
   date('now','localtime','-4 days') || 'T19:45:00',
   date('now','localtime','-4 days') || 'T19:45:00', 0, NULL, NULL, NULL, NULL, 0, ''),
  ('demo-b-trip', 'Plan anniversary trip',
   'backlog', 'active', NULL, 5,
   date('now','localtime','-9 days') || 'T20:10:00',
   date('now','localtime','-1 days') || 'T00:01:00', 0, NULL, NULL, NULL, NULL, 0, ''),
  ('demo-b-dentist', 'Book dentist appointment',
   'backlog', 'active', NULL, 6,
   date('now','localtime','-2 days') || 'T12:00:00',
   date('now','localtime','-2 days') || 'T12:00:00', 0, NULL, NULL, date('now','localtime','+3 days'), NULL, 0, ''),
  ('demo-b-pricing', 'Research competitor pricing pages',
   'backlog', 'active', NULL, 7,
   date('now','localtime','-2 days') || 'T16:30:00',
   date('now','localtime','-2 days') || 'T16:30:00', 0, NULL, 'demo-p-growth', NULL, NULL, 1,
   'Visit the pricing pages of the five competitors in the market sheet. For each, note: the pricing model (flat / seat / usage), the entry price, what the free tier includes, and the single most persuasive element on the page. Summarize as a table in a note titled "Pricing landscape".'),
  ('demo-b-copy', 'Old landing page copy drafts',
   'backlog', 'active', NULL, 8,
   date('now','localtime','-25 days') || 'T14:00:00',
   date('now','localtime','-10 days') || 'T18:00:00', 1, NULL, 'demo-p-growth', NULL, NULL, 0, '');

-- ---- Notes -------------------------------------------------------------------
-- Scratch in the app's own voice: an idea list, standup scribbles, one hidden.
-- Two carry priority + a project link (the same axes tasks have — the token
-- line is input syntax, consumed at capture; bodies stay pure prose).

INSERT INTO notes (id, body, sort_order, created_at, updated_at, hidden, hidden_until, priority, project_id) VALUES
  ('demo-n-idea',
   'Waitlist page ideas
- add a 30-second demo GIF above the fold
- social proof line: "join 1,200 builders"
- A/B a plain-text email against the designed template',
   0,
   date('now','localtime','-3 days') || 'T10:22:00',
   date('now','localtime','-3 days') || 'T10:31:00', 0, NULL, 1, 'demo-p-growth'),
  ('demo-n-standup',
   'Standup notes
- search ranking fix ships today, PR is green
- mobile beta still blocked on the capture-inbox bug, repro is in the ticket
- record the screencast for this week''s changelog',
   1,
   date('now','localtime','-1 days') || 'T09:50:00',
   date('now','localtime','-1 days') || 'T09:58:00', 0, NULL, 2, 'demo-p-meridian'),
  ('demo-n-gifts',
   'Gift ideas for dad — fishing rod, nice whiskey, that cheese board',
   2,
   date('now','localtime','-12 days') || 'T18:40:00',
   date('now','localtime','-12 days') || 'T18:40:00', 1, NULL, NULL, NULL);

-- ---- Sessions ------------------------------------------------------------------
-- Closed sessions across the week so per-task ⏱ totals and the journal's
-- per-day/per-task breakdown have real numbers. No open row: entering demo
-- mode starts with no timer running.

INSERT INTO sessions (id, item_id, item_text, started_at, ended_at, duration_secs) VALUES
  ('demo-s-t1', 'demo-d-deepwork', 'Morning deep work block',
   date('now','localtime') || 'T09:00:00', date('now','localtime') || 'T10:25:00', 5100),
  ('demo-s-t2', 'demo-t-crash', 'Fix crash on first-launch onboarding',
   date('now','localtime') || 'T10:32:00', date('now','localtime') || 'T11:14:00', 2520),
  ('demo-s-y1', 'demo-d-deepwork', 'Morning deep work block',
   date('now','localtime','-1 days') || 'T09:30:00', date('now','localtime','-1 days') || 'T11:15:00', 6300),
  ('demo-s-y2', 'demo-t-pr', 'Review PR #214 — search ranking tweak',
   date('now','localtime','-1 days') || 'T13:55:00', date('now','localtime','-1 days') || 'T15:10:00', 4500),
  ('demo-s-d2a', 'demo-d-deepwork', 'Morning deep work block',
   date('now','localtime','-2 days') || 'T09:00:00', date('now','localtime','-2 days') || 'T10:40:00', 6000),
  ('demo-s-d3a', 'demo-x-blog', 'Write the launch blog post',
   date('now','localtime','-3 days') || 'T10:05:00', date('now','localtime','-3 days') || 'T12:00:00', 6900),
  ('demo-s-d5a', 'demo-d-deepwork', 'Morning deep work block',
   date('now','localtime','-5 days') || 'T09:05:00', date('now','localtime','-5 days') || 'T10:35:00', 5400);

-- ---- Actions --------------------------------------------------------------------
-- A week of history, in strict chronological order (id order = the journal's
-- display order, newest-first, within each day). fell_to_backlog rows land at
-- 00:01 — the day-boundary sweep — and their items' updated_at matches.

-- A month back: the identity layer.
INSERT INTO actions (item_id, goal_id, item_text, action, from_section, to_section, from_status, to_status, timestamp) VALUES
  (NULL, 'demo-g-timeless', 'Build software people genuinely love using', 'goal_created', NULL, 'timeless', NULL, 'active',
   date('now','localtime','-30 days') || 'T21:30:00'),
  (NULL, 'demo-g-long', 'Grow meridian into a profitable one-person business', 'goal_created', NULL, 'long', NULL, 'active',
   date('now','localtime','-30 days') || 'T21:35:00'),
  (NULL, 'demo-g-waitlist', 'Launch the public waitlist page', 'goal_created', NULL, 'short', NULL, 'active',
   date('now','localtime','-15 days') || 'T10:00:00'),
  ('demo-b-trip', NULL, 'Plan anniversary trip', 'created', NULL, 'backlog', NULL, 'active',
   date('now','localtime','-9 days') || 'T20:10:00'),
  (NULL, 'demo-g-waitlist', 'Launch the public waitlist page', 'goal_achieved', 'short', 'short', 'active', 'achieved',
   date('now','localtime','-8 days') || 'T16:20:00'),
  ('demo-x-ci', NULL, 'Set up CI cache for faster builds', 'created', NULL, 'backlog', NULL, 'active',
   date('now','localtime','-7 days') || 'T10:15:00'),
  (NULL, 'demo-g-beta', 'Ship the mobile beta to 100 users', 'goal_created', NULL, 'short', NULL, 'active',
   date('now','localtime','-6 days') || 'T08:40:00'),
  ('demo-b-ssl', NULL, 'Renew meridian SSL certificate', 'created', NULL, 'backlog', NULL, 'active',
   date('now','localtime','-6 days') || 'T10:00:00');

-- Five days back: launches, writes, and the newsletter's complete/undo/redo.
INSERT INTO actions (item_id, goal_id, item_text, action, from_section, to_section, from_status, to_status, timestamp) VALUES
  ('demo-x-blog', NULL, 'Write the launch blog post', 'created', NULL, 'backlog', NULL, 'active',
   date('now','localtime','-5 days') || 'T09:20:00'),
  ('demo-d-deepwork', NULL, 'Morning deep work block', 'completed', 'daily', 'daily', 'active', 'active',
   date('now','localtime','-5 days') || 'T10:35:00'),
  ('demo-b-roadmap', NULL, 'Sketch the product roadmap', 'created', NULL, 'backlog', NULL, 'active',
   date('now','localtime','-5 days') || 'T15:30:00'),
  ('demo-d-read', NULL, 'Read 20 pages', 'completed', 'daily', 'daily', 'active', 'active',
   date('now','localtime','-5 days') || 'T21:40:00'),
  ('demo-x-news', NULL, 'Send newsletter issue #12', 'created', NULL, 'backlog', NULL, 'active',
   date('now','localtime','-5 days') || 'T21:50:00');

INSERT INTO actions (item_id, goal_id, item_text, action, from_section, to_section, from_status, to_status, timestamp) VALUES
  ('demo-x-news', NULL, 'Send newsletter issue #12', 'moved', 'backlog', 'today', NULL, NULL,
   date('now','localtime','-4 days') || 'T09:00:00'),
  ('demo-b-funnel', NULL, 'Audit onboarding funnel drop-off', 'created', NULL, 'backlog', NULL, 'active',
   date('now','localtime','-4 days') || 'T09:10:00'),
  ('demo-t-gym', NULL, 'Gym — push day', 'created', NULL, 'backlog', NULL, 'active',
   date('now','localtime','-4 days') || 'T09:30:00'),
  ('demo-x-news', NULL, 'Send newsletter issue #12', 'completed', 'today', 'today', 'active', 'done',
   date('now','localtime','-4 days') || 'T15:00:00'),
  ('demo-x-news', NULL, 'Send newsletter issue #12', 'uncompleted', 'today', 'today', 'done', 'active',
   date('now','localtime','-4 days') || 'T15:40:00'),
  ('demo-x-news', NULL, 'Send newsletter issue #12', 'completed', 'today', 'today', 'active', 'done',
   date('now','localtime','-4 days') || 'T16:10:00'),
  ('demo-b-shapeup', NULL, 'Re-read Shape Up', 'created', NULL, 'backlog', NULL, 'active',
   date('now','localtime','-4 days') || 'T19:45:00');

-- Three days back: the blog ships (its done row retired at the next sweep —
-- history-only now), funnel comes up for its audit.
INSERT INTO actions (item_id, goal_id, item_text, action, from_section, to_section, from_status, to_status, timestamp) VALUES
  ('demo-x-blog', NULL, 'Write the launch blog post', 'moved', 'backlog', 'today', NULL, NULL,
   date('now','localtime','-3 days') || 'T08:30:00'),
  ('demo-b-funnel', NULL, 'Audit onboarding funnel drop-off', 'moved', 'backlog', 'today', NULL, NULL,
   date('now','localtime','-3 days') || 'T08:50:00'),
  ('demo-b-analytics', NULL, 'Self-host the analytics stack', 'created', NULL, 'backlog', NULL, 'active',
   date('now','localtime','-3 days') || 'T13:20:00'),
  ('demo-x-blog', NULL, 'Write the launch blog post', 'completed', 'today', 'today', 'active', 'done',
   date('now','localtime','-3 days') || 'T14:30:00');

-- Two days back: funnel's audit didn't happen — the sweep catches it at 00:01.
INSERT INTO actions (item_id, goal_id, item_text, action, from_section, to_section, from_status, to_status, timestamp) VALUES
  ('demo-b-funnel', NULL, 'Audit onboarding funnel drop-off', 'fell_to_backlog', 'today', 'backlog', NULL, NULL,
   date('now','localtime','-2 days') || 'T00:01:00'),
  ('demo-t-pr', NULL, 'Review PR #214 — search ranking tweak', 'created', NULL, 'backlog', NULL, 'active',
   date('now','localtime','-2 days') || 'T11:12:00'),
  ('demo-d-deepwork', NULL, 'Morning deep work block', 'completed', 'daily', 'daily', 'active', 'active',
   date('now','localtime','-2 days') || 'T11:15:00'),
  ('demo-b-dentist', NULL, 'Book dentist appointment', 'created', NULL, 'backlog', NULL, 'active',
   date('now','localtime','-2 days') || 'T12:00:00'),
  ('demo-b-pricing', NULL, 'Research competitor pricing pages', 'created', NULL, 'backlog', NULL, 'active',
   date('now','localtime','-2 days') || 'T16:30:00'),
  ('demo-t-interviews', NULL, 'Compile user interview insights', 'created', NULL, 'backlog', NULL, 'active',
   date('now','localtime','-2 days') || 'T16:45:00'),
  ('demo-b-trip', NULL, 'Plan anniversary trip', 'moved', 'backlog', 'today', NULL, NULL,
   date('now','localtime','-2 days') || 'T19:00:00'),
  ('demo-d-read', NULL, 'Read 20 pages', 'completed', 'daily', 'daily', 'active', 'active',
   date('now','localtime','-2 days') || 'T22:05:00');

-- Yesterday: trip falls back (the sweep again), the morning pull into Today,
-- the support inbox cleared, the roadmap renamed, the CI chore dropped.
INSERT INTO actions (item_id, goal_id, item_text, action, from_section, to_section, from_status, to_status, timestamp) VALUES
  ('demo-b-trip', NULL, 'Plan anniversary trip', 'fell_to_backlog', 'today', 'backlog', NULL, NULL,
   date('now','localtime','-1 days') || 'T00:01:00'),
  ('demo-t-crash', NULL, 'Fix crash on first-launch onboarding', 'created', NULL, 'backlog', NULL, 'active',
   date('now','localtime','-1 days') || 'T08:55:00'),
  ('demo-t-pr', NULL, 'Review PR #214 — search ranking tweak', 'moved', 'backlog', 'today', NULL, NULL,
   date('now','localtime','-1 days') || 'T09:05:00'),
  ('demo-t-crash', NULL, 'Fix crash on first-launch onboarding', 'moved', 'backlog', 'today', NULL, NULL,
   date('now','localtime','-1 days') || 'T09:08:00'),
  ('demo-x-support', NULL, 'Reply to pending support emails', 'created', NULL, 'today', NULL, 'active',
   date('now','localtime','-1 days') || 'T09:15:00'),
  ('demo-t-interviews', NULL, 'Compile user interview insights', 'moved', 'backlog', 'today', NULL, NULL,
   date('now','localtime','-1 days') || 'T09:20:00'),
  ('demo-t-gym', NULL, 'Gym — push day', 'moved', 'backlog', 'today', NULL, NULL,
   date('now','localtime','-1 days') || 'T09:25:00'),
  ('demo-x-support', NULL, 'Reply to pending support emails', 'completed', 'today', 'today', 'active', 'done',
   date('now','localtime','-1 days') || 'T11:05:00'),
  ('demo-d-deepwork', NULL, 'Morning deep work block', 'completed', 'daily', 'daily', 'active', 'active',
   date('now','localtime','-1 days') || 'T11:15:00'),
  ('demo-b-roadmap', NULL, 'Draft next quarter''s product roadmap', 'edited', 'backlog', 'backlog', NULL, NULL,
   date('now','localtime','-1 days') || 'T11:40:00'),
  ('demo-x-ci', NULL, 'Set up CI cache for faster builds', 'deleted', 'backlog', NULL, NULL, NULL,
   date('now','localtime','-1 days') || 'T17:00:00');

-- Today so far.
INSERT INTO actions (item_id, goal_id, item_text, action, from_section, to_section, from_status, to_status, timestamp) VALUES
  ('demo-d-walk', NULL, 'Walk 8k steps', 'completed', 'daily', 'daily', 'active', 'active',
   date('now','localtime') || 'T07:12:00'),
  ('demo-t-investor', NULL, 'Draft monthly investor update', 'created', NULL, 'today', NULL, 'active',
   date('now','localtime') || 'T08:15:00'),
  ('demo-t-crash', NULL, 'Fix crash on first-launch onboarding', 'completed', 'today', 'today', 'active', 'done',
   date('now','localtime') || 'T09:41:00');

COMMIT;

// App — the shell. Owns app-wide state (items, selection, view, zoom), effects
// (load, sweep tick, self-update events), and global keyboard handlers (⌘P,
// ⌘F, ⌘+/⌘-, j/k).
// Everything else is delegated to focused components in ./components.
//
// Layout contract (see AGENTS.md "Layout architecture"): the header is pinned
// and a single `.scroll` wrapper scrolls the whole body. Never add a second
// `overflow-y: auto` to a child — that's what caused the split-scroll bug.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, formatLiveDuration, hideExpiry, localDateStr, parseItemTags, projectsApi, syncApi, timersApi, type ActiveTimer, type HideDuration, type Item, type Project, type Section } from "./lib";
import { log } from "./log";
import Notes from "./Notes";
import Goals from "./Goals";
import SectionList from "./components/SectionList";
import JournalView from "./components/JournalView";
import CommandPalette, { type Command } from "./CommandPalette";
import SearchMenu, { type SearchHit } from "./components/SearchMenu";
import UpdateOverlay from "./UpdateOverlay";
import MobileView from "./MobileView";
import MobileSyncSettings from "./MobileSyncSettings";

type View = "list" | "journal";

// Labels for the per-section ⌘P toggles (Show/Hide Today, …).
const SECTION_LABELS: Record<Section, string> = {
  today: "Today", daily: "Daily", backlog: "Backlog",
};

// ⌘+/⌘- zoom bounds and step, in the comfortable-reading range around the 13px
// base — much beyond it and the fixed 480px window stops fitting a list. The
// round-to-10th keeps float drift (0.1 + 0.2 style) from wedging the clamps.
const ZOOM_MIN = 0.7;
const ZOOM_MAX = 1.6;
const ZOOM_STEP = 0.1;
const clampZoom = (z: number) =>
  Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 10) / 10));

// Masthead brand rotation: the "Live @ " words the header steps out to, one
// picked at random every 2 minutes before returning to "Faraz" (home).
const MASTHEAD_THEMES = ["growth", "money", "journey", "learn"] as const;

// The Backlog's display order, mirroring the backend's ORDER BY (db.rs list):
// priority first (unmarked last), then manual order. Optimistic updates that
// touch priority or ordering must re-apply it — the tier dividers in
// SectionView read the rendered order, so a row left out of tier splits one
// tier group into two dividers until the next 60s refresh re-syncs. sortOrder
// is kept truthful optimistically (settleBacklogDrop), so this comparator is exact
// against what a refresh returns.
const sortBacklog = (list: Item[]) =>
  [...list].sort(
    (a, b) =>
      (a.priority ?? 99) - (b.priority ?? 99) ||
      a.sortOrder - b.sortOrder ||
      a.createdAt.localeCompare(b.createdAt),
  );

// Re-apply the Backlog's ordering after an optimistic drop. move_item
// re-indexes sort_order 0..N across the section over the tier-sorted sequence
// with the dropped row inserted at the target index — reproduce exactly that
// indexing (and the display order it implies), so the optimistic list is what
// the next refresh returns and sortBacklog's comparator stays truthful for
// later creates/edits. `spliced` is the destination list with the moved row
// already spliced in at `fullIndex`.
const settleBacklogDrop = (spliced: Item[], movedId: string, fullIndex: number) => {
  const moved = spliced.find((i) => i.id === movedId);
  if (!moved) return spliced;
  // The destination minus the moved row is still in its tier-sorted order
  // (the invariant above), so re-inserting at fullIndex rebuilds the same
  // sequence the backend indexes over.
  const seq = spliced.filter((i) => i.id !== movedId);
  seq.splice(Math.min(fullIndex, seq.length), 0, moved);
  return sortBacklog(seq.map((i, idx) => (i.sortOrder === idx ? i : { ...i, sortOrder: idx })));
};

// Self-update status, accumulated from "update-status" events emitted by the
// backend's self_update command. `lines` is the streamed build log; `message`
// is populated only on error.
export type UpdateStatus = {
  phase: "building" | "restarting" | "error";
  lines: string[];
  message: string;
};

// The Android build runs the same webview bundle but renders the mobile
// client instead of the desktop shell — a read-only mirror of the list plus
// the capture inbox (see MobileView.tsx and AGENTS.md "Mobile sync").
const IS_MOBILE = /android/i.test(navigator.userAgent);

export default function App() {
  if (IS_MOBILE) return <MobileView />;
  return <DayApp />;
}

function DayApp() {
  const [items, setItems] = useState<Record<Section, Item[]>>({
    today: [],
    daily: [],
    backlog: [],
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [view, setView] = useState<View>("list");
  // ---- Show/Hide toggles (⌘P) ---------------------------------------------
  // Every layout surface is an independent toggle whose palette label reflects
  // its state ("Show X" / "Hide X"). All persist in localStorage — display
  // preferences like zoom, not session filters; Show Default View is the one
  // universal reset (it hides the goals: the default working view is the plain
  // task list). Show Hidden Tasks/Notes render hidden entries inline (dimmed,
  // ↺/× actions) instead of excluding them; the header ◐ toggles both at once.
  const [goalsVisible, setGoalsVisible] = useState(
    () => localStorage.getItem("dayapp-goals-visible") !== "0",
  );
  const [notesVisible, setNotesVisible] = useState(
    () => localStorage.getItem("dayapp-notes-visible") !== "0",
  );
  const [sectionsVisible, setSectionsVisible] = useState<Record<Section, boolean>>(() => ({
    today: localStorage.getItem("dayapp-sec-today") !== "0",
    daily: localStorage.getItem("dayapp-sec-daily") !== "0",
    backlog: localStorage.getItem("dayapp-sec-backlog") !== "0",
  }));
  const [showHiddenItems, setShowHiddenItems] = useState(
    () => localStorage.getItem("dayapp-hidden-items") === "1",
  );
  const [showHiddenNotes, setShowHiddenNotes] = useState(
    () => localStorage.getItem("dayapp-hidden-notes") === "1",
  );
  // ⌘P "Show/Hide Priority N" — three independent per-tier toggles; a tier in
  // this list is hidden from the main list. Unmarked rows are never touched,
  // and toggling one tier leaves the others alone.
  const [hiddenPriorities, setHiddenPriorities] = useState<(1 | 2 | 3)[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("dayapp-hidden-priorities") ?? "[]");
      return [1, 2, 3].filter((n) => raw.includes(n)) as (1 | 2 | 3)[];
    } catch {
      return [];
    }
  });
  // ⌘F "#project" — narrow the list to one project; null = off. The one
  // session-only filter (a search-shaped focus, not a layout preference);
  // composed with the priority tier in displayItems.
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [syncSettingsOpen, setSyncSettingsOpen] = useState(false);
  // Transient feedback pill for palette-triggered flows (deploy/pull results).
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number>(0);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeTimer, setActiveTimer] = useState<ActiveTimer | null>(null);
  const [timeTotals, setTimeTotals] = useState<Record<string, number>>({});
  // Wall-clock tick; bumped once a second while a timer runs, so the chip and
  // running row's elapsed update live. Idle (no re-render loop) when idle.
  const [now, setNow] = useState(() => Date.now());
  // UI zoom (⌘+/⌘-/⌘0). Persisted in localStorage — it's a display preference,
  // unlike the session-only visibility/priority filters.
  const [zoom, setZoom] = useState(() => {
    const saved = Number(localStorage.getItem("dayapp-zoom"));
    return Number.isFinite(saved) && saved >= ZOOM_MIN && saved <= ZOOM_MAX ? saved : 1;
  });
  // The masthead brand word after "Live @ " — "Faraz" is home. Session-only:
  // a launch always starts at home.
  const [liveAt, setLiveAt] = useState("Faraz");
  // The theme shown before the current home stretch — the next pick avoids it,
  // so the rotation shuffles rather than dice-rolls repeats.
  const lastTheme = useRef("");
  // Pull-and-ingest the mobile capture inbox. Assigned after handleCreate is
  // defined (it ingests through the normal create path so #tag/!N tokens
  // parse); the ref lets the 60s tick call the freshest closure.
  const ingestRef = useRef<() => Promise<number>>(async () => 0);

  // ---- Load -------------------------------------------------------------

  const refresh = useCallback(async () => {
    const hidden = showHiddenItems ? "include" : "exclude";
    const [today, daily, backlog, projs] = await Promise.all([
      // Completed Today rows stay in the list — crossed out, like a done
      // daily — until the day-boundary sweep retires them, so only Today
      // asks for done rows.
      api.listItems("today", true, hidden),
      api.listItems("daily", false, hidden),
      api.listItems("backlog", false, hidden),
      projectsApi.list(),
    ]);
    setItems({ today, daily, backlog });
    setProjects(projs);
  }, [showHiddenItems]);

  useEffect(() => {
    refresh().catch((e) => log.error("initial load failed", e));
    // Re-check the day boundary while the app stays open. If local time crosses
    // midnight, run the sweep so Today items fall to Backlog without a relaunch.
    // The same tick drains the phone's capture inbox, so a capture made while
    // walking lands within a minute of the Mac app being open.
    const tick = setInterval(() => {
      api.runSweep().then(refresh).catch((e) => log.warn("sweep tick failed", e));
      ingestRef.current()
        .then((n) => { if (n > 0) refresh(); })
        .catch((e) => log.warn("sync: capture pull failed", e));
    }, 60_000);
    // One pull shortly after launch (captures queued while the app was closed).
    const first = setTimeout(() => {
      ingestRef.current()
        .then((n) => { if (n > 0) refresh(); })
        .catch((e) => log.warn("sync: capture pull failed", e));
    }, 4_000);
    return () => { clearInterval(tick); clearTimeout(first); };
  }, [refresh]);

  // The active timer persists across app restarts (its open session row is the
  // source of truth), so restore it on mount. The elapsed may be large if the
  // app was closed mid-session — that's the honest count; the chip offers a
  // discard for the "left it running overnight" case.
  useEffect(() => {
    timersApi.active().then(setActiveTimer).catch((e) => log.warn("active timer load failed", e));
  }, []);

  // Browser-style page zoom, set on <html>: every px dimension (fonts, rows,
  // modals, the fixed overlays) scales together, so proportions hold at any
  // size. Metrics like the notes' scrollHeight are read in each element's
  // local (unzoomed) space, so the auto-grow logic doesn't skew under it.
  useEffect(() => {
    document.documentElement.style.zoom = String(zoom);
    localStorage.setItem("dayapp-zoom", String(zoom));
  }, [zoom]);

  useEffect(() => {
    localStorage.setItem("dayapp-goals-visible", goalsVisible ? "1" : "0");
    localStorage.setItem("dayapp-notes-visible", notesVisible ? "1" : "0");
    localStorage.setItem("dayapp-sec-today", sectionsVisible.today ? "1" : "0");
    localStorage.setItem("dayapp-sec-daily", sectionsVisible.daily ? "1" : "0");
    localStorage.setItem("dayapp-sec-backlog", sectionsVisible.backlog ? "1" : "0");
    localStorage.setItem("dayapp-hidden-items", showHiddenItems ? "1" : "0");
    localStorage.setItem("dayapp-hidden-notes", showHiddenNotes ? "1" : "0");
    localStorage.setItem("dayapp-hidden-priorities", JSON.stringify(hiddenPriorities));
    // Retired key from the single-tier "only" filter era — one-time cleanup.
    localStorage.removeItem("dayapp-priority");
  }, [goalsVisible, notesVisible, sectionsVisible, showHiddenItems, showHiddenNotes, hiddenPriorities]);

  // Brand rotation: every 2 minutes toggle home ↔ a random theme. The tick
  // runs in every view; the journal title simply ignores it.
  useEffect(() => {
    const id = setInterval(() => {
      setLiveAt((word) => {
        if (word !== "Faraz") return "Faraz";
        const pool = MASTHEAD_THEMES.filter((t) => t !== lastTheme.current);
        const pick = pool[Math.floor(Math.random() * pool.length)];
        lastTheme.current = pick;
        return pick;
      });
    }, 120_000);
    return () => clearInterval(id);
  }, []);

  // What the user sees: items narrowed by the ⌘P hidden priority tiers and/or
  // the ⌘F project filter, if any. Hiding a tier removes just that tier's
  // rows — unmarked rows stay, and each tier is independent. Mutations read
  // the full `items`, and DnD indexes map back to full-list space in
  // handleMoveItem.
  const displayItems = useMemo<Record<Section, Item[]>>(() => {
    if (hiddenPriorities.length === 0 && projectFilter === null) return items;
    const matches = (i: Item) =>
      (i.priority === null || !hiddenPriorities.includes(i.priority)) &&
      (projectFilter === null || i.projectId === projectFilter);
    return {
      today: items.today.filter(matches),
      daily: items.daily.filter(matches),
      backlog: items.backlog.filter(matches),
    };
  }, [items, hiddenPriorities, projectFilter]);

  // displayItems narrowed to the visible sections — a toggled-off section's
  // rows aren't rendered, searchable, keyboard-navigable, or totaled (they
  // stay in state; only the view skips them).
  const renderItems = useMemo<Record<Section, Item[]>>(() => ({
    today: sectionsVisible.today ? displayItems.today : [],
    daily: sectionsVisible.daily ? displayItems.daily : [],
    backlog: sectionsVisible.backlog ? displayItems.backlog : [],
  }), [displayItems, sectionsVisible]);

  // All currently-visible item ids — drives the per-row cumulative totals fetch.
  const allIds = useMemo(
    () => [...renderItems.today, ...renderItems.daily, ...renderItems.backlog].map((i) => i.id),
    [renderItems],
  );

  const refreshTotals = useCallback(async () => {
    if (allIds.length === 0) { setTimeTotals({}); return; }
    try {
      setTimeTotals(await timersApi.totals(allIds));
    } catch (e) { log.warn("time totals failed", e); }
  }, [allIds]);

  useEffect(() => { refreshTotals(); }, [refreshTotals]);

  // Tick once a second while a timer runs so the header chip + the running row's
  // elapsed are live. No interval when nothing's timing — no busy work.
  useEffect(() => {
    if (!activeTimer) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [activeTimer]);

  // Live elapsed for the active timer, in seconds. Both startedAt (from the
  // backend's local RFC3339) and Date.now() resolve to epoch ms, so the diff is
  // correct wall-clock elapsed regardless of the timestamp's offset suffix.
  const liveElapsed = activeTimer
    ? Math.max(0, Math.floor((now - new Date(activeTimer.startedAt).getTime()) / 1000))
    : 0;

  // ---- Self-update: accumulate "update-status" events from the backend ----
  // Each building line appends to the log; restarting/error flip the phase.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{ phase: string; data: string }>("update-status", (e) => {
        const { phase, data } = e.payload;
        if (phase === "restarting") log.info("update: build done, restarting");
        else if (phase === "error") log.error("update: build failed", data);
        setUpdateStatus((prev) => {
          if (phase === "building") {
            const lines = prev && prev.phase === "building" ? [...prev.lines, data] : [data];
            return { phase: "building", lines, message: "" };
          }
          if (phase === "restarting") {
            return { phase: "restarting", lines: prev?.lines ?? [], message: "" };
          }
          if (phase === "error") {
            return { phase: "error", lines: prev?.lines ?? [], message: data };
          }
          return prev;
        });
      });
    })();
    return () => { unlisten?.(); };
  }, []);

  const startUpdate = useCallback(() => {
    log.info("update: starting in-app self-update");
    setUpdateStatus({ phase: "building", lines: [], message: "" });
    api.selfUpdate().catch((err) => {
      log.error("update: invoke failed", err);
      setUpdateStatus({ phase: "error", lines: [], message: String(err) });
    });
  }, []);

  // ---- Command palette registry -----------------------------------------
  // Every layout surface is a state-aware Show/Hide toggle (persisted); the
  // one non-toggle is the universal reset. Labels reflect the current state,
  // so re-running a command always reads as its inverse.
  const commands: Command[] = useMemo(() => [
    {
      id: "view-default",
      label: "Show Default View",
      hint: "reset every toggle + filter",
      // The universal reset: hidden entries excluded, filters cleared, all
      // sections + Notes shown — and Goals hidden (the default working view
      // is the plain task list).
      run: () => {
        setView("list");
        setShowHiddenItems(false);
        setShowHiddenNotes(false);
        setHiddenPriorities([]);
        setProjectFilter(null);
        setSectionsVisible({ today: true, daily: true, backlog: true });
        setNotesVisible(true);
        setGoalsVisible(false);
      },
    },
    {
      id: "toggle-goals",
      label: goalsVisible ? "Hide Goals" : "Show Goals",
      hint: "the goals section",
      run: () => { setView("list"); setGoalsVisible((v) => !v); },
    },
    {
      id: "toggle-notes",
      label: notesVisible ? "Hide Notes" : "Show Notes",
      hint: "the notes section",
      run: () => { setView("list"); setNotesVisible((v) => !v); },
    },
    ...(["today", "daily", "backlog"] as const).map((s) => ({
      id: `toggle-${s}`,
      label: sectionsVisible[s] ? `Hide ${SECTION_LABELS[s]}` : `Show ${SECTION_LABELS[s]}`,
      hint: "section",
      run: () => {
        setView("list");
        setSectionsVisible((v) => ({ ...v, [s]: !v[s] }));
      },
    })),
    {
      id: "toggle-hidden-items",
      label: showHiddenItems ? "Hide Hidden Tasks" : "Show Hidden Tasks",
      hint: "inline, dimmed",
      run: () => { setView("list"); setShowHiddenItems((v) => !v); },
    },
    {
      id: "toggle-hidden-notes",
      label: showHiddenNotes ? "Hide Hidden Notes" : "Show Hidden Notes",
      hint: "inline, dimmed",
      run: () => { setView("list"); setShowHiddenNotes((v) => !v); },
    },
    ...([1, 2, 3] as const).map((n) => ({
      id: `prio-${n}`,
      // Mirrors the row's signal bars: filled count = urgency (P1 = 3).
      // Independent like the section toggles: flipping one tier never
      // touches the others (or the unmarked rows).
      label: hiddenPriorities.includes(n) ? `Show Priority ${n}` : `Hide Priority ${n}`,
      hint: "▮".repeat(4 - n),
      run: () => {
        setView("list");
        setHiddenPriorities((h) =>
          h.includes(n) ? h.filter((p) => p !== n) : [...h, n],
        );
      },
    })),
    {
      id: "mobile-deploy",
      label: "Mobile: Deploy Task List Now",
      hint: "push to GitHub",
      run: () => {
        syncApi.deploy(true)
          .then((m) => { log.info(`sync: deploy — ${m}`); showToast(`Deploy: ${m}`); })
          .catch((e) => { log.error("sync: deploy failed", e); showToast(`Deploy failed: ${e}`); });
      },
    },
    {
      id: "mobile-pull",
      label: "Mobile: Pull Captures Now",
      hint: "ingest from phone",
      run: () => {
        ingestRef.current()
          .then((n) => {
            if (n > 0) refresh();
            showToast(n ? `Ingested ${n} capture${n === 1 ? "" : "s"}` : "No new captures");
          })
          .catch((e) => { log.error("sync: pull failed", e); showToast(`Pull failed: ${e}`); });
      },
    },
    {
      id: "mobile-configure",
      label: "Mobile: Configure Sync…",
      hint: "repo + token",
      run: () => setSyncSettingsOpen(true),
    },
    { id: "view-journal", label: "View Journal", run: () => setView("journal") },
    {
      id: "update",
      label: "Update DayApp",
      hint: "rebuild from source",
      run: startUpdate,
    },
  ], [startUpdate, refresh, showToast, goalsVisible, notesVisible, sectionsVisible, showHiddenItems, showHiddenNotes, hiddenPriorities]);

  // ⌘P toggles the palette; ⌘F opens search; ⌘+/⌘- zoom the whole UI in/out
  // (⌘0 resets). All intercept globally (they're modifier combos, so they
  // don't interfere with typing in a field).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "p") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key === "f") {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        setZoom((z) => clampZoom(z + ZOOM_STEP));
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setZoom((z) => clampZoom(z - ZOOM_STEP));
      } else if (e.key === "0") {
        e.preventDefault();
        setZoom(1);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ---- Mutations --------------------------------------------------------

  // Create a project and land it in state immediately. Both creation paths —
  // the # popover's inline field and a trailing `#tag` in capture/edit text —
  // go through this, because the row's project label renders from this state:
  // a project missing from it would leave the just-assigned row unlabeled
  // until the next 60s refresh.
  const handleCreateProject = async (name: string): Promise<Project> => {
    const created = await projectsApi.create(name);
    setProjects((p) => [...p, created]);
    return created;
  };

  // A trailing unmatched `#tag` (e.g. "fix bug #acme" with no "acme" project)
  // creates the project in place. Same housekeeping path as the # popover's
  // create field — just triggered by typing the tag at the end of the text.
  // Returns the new project id, or null when there's nothing to create.
  const materializeTagProject = async (name?: string): Promise<string | null> => {
    if (!name) return null;
    return (await handleCreateProject(name)).id;
  };

  const handleCreate = async (section: Section, raw: string) => {
    // Resolve `#tag` → project and `!1..3` → priority on capture (e.g.
    // "fix bug #day !2" → dayapp project, priority 2), stripping both tokens
    // from the text. Assignment is housekeeping, so it happens after the item
    // exists.
    const { text, projectId, createProjectName, priority } = parseItemTags(raw, projects);
    const item = await api.createItem(text, section);
    const assignId = projectId ?? (await materializeTagProject(createProjectName));
    // !0 ("clear") is a no-op at capture — a fresh item has no priority yet.
    const tier = priority === 0 ? null : priority;
    const patch: Partial<Item> = {};
    if (assignId) patch.projectId = assignId;
    if (tier !== null) patch.priority = tier;
    setItems((s) => ({
      ...s,
      // A backlog capture with a !N token must land in its tier group right
      // away — appended at the end it would render under the wrong divider
      // until the next refresh.
      [section]: section === "backlog"
        ? sortBacklog([...s.backlog, { ...item, ...patch }])
        : [...s[section], { ...item, ...patch }],
    }));
    if (assignId) api.setItemProject(item.id, assignId);
    if (tier !== null) api.setItemPriority(item.id, tier);
  };

  // Drain the phone's capture inbox: each entry goes through handleCreate (so
  // `#tag`/`!N` tokens parse exactly like desktop capture), then its id is
  // recorded in meta — the guard that makes double-ingest impossible.
  ingestRef.current = async () => {
    const caps = await syncApi.pull();
    if (caps.length === 0) return 0;
    log.info(`sync: ingesting ${caps.length} mobile capture(s)`);
    for (const c of caps) {
      await handleCreate(c.section === "today" ? "today" : "backlog", c.text);
    }
    await syncApi.markIngested(caps.map((c) => c.id));
    return caps.length;
  };

  const handleComplete = async (id: string, section: Section) => {
    // A crossed Today row toggles back off — Enter or a checkbox click
    // un-completes it. (Daily has no inverse: its completion is just
    // "done for today".)
    if (section === "today" && items.today.find((i) => i.id === id)?.status === "done") {
      setItems((s) => ({
        ...s,
        today: s.today.map((i) =>
          i.id === id ? { ...i, status: "active", lastCompletedDate: null } : i,
        ),
      }));
      await api.uncompleteItem(id);
      return;
    }
    // Completing a running item stops its timer first — the session is kept.
    if (activeTimer?.itemId === id) {
      setActiveTimer(null);
      timersApi.stop().catch((e) => log.warn("auto-stop on complete failed", e));
    }
    if (section === "daily") {
      setItems((s) => ({
        ...s,
        daily: s.daily.map((i) =>
          i.id === id ? { ...i, lastCompletedDate: localDateStr() } : i,
        ),
      }));
    } else if (section === "today") {
      // Stays in place, crossed out; the day-boundary sweep retires it.
      setItems((s) => ({
        ...s,
        today: s.today.map((i) =>
          i.id === id ? { ...i, status: "done", lastCompletedDate: localDateStr() } : i,
        ),
      }));
    } else {
      setItems((s) => ({
        ...s,
        [section]: s[section].filter((i) => i.id !== id),
      }));
    }
    await api.completeItem(id);
  };

  const handleDelete = async (id: string, section: Section) => {
    // Deleting a running item stops its timer first (session history is kept —
    // the item_text snapshot in sessions survives the deletion, like actions).
    if (activeTimer?.itemId === id) {
      setActiveTimer(null);
      timersApi.stop().catch((e) => log.warn("auto-stop on delete failed", e));
    }
    setItems((s) => ({ ...s, [section]: s[section].filter((i) => i.id !== id) }));
    await api.deleteItem(id);
  };

  const handleCommitEdit = async (id: string, raw: string) => {
    const { text, projectId, createProjectName, priority } = parseItemTags(raw, projects);
    setEditingId(null);
    if (!text) return;
    // Apply the stripped text, and — only if a token resolved or created a
    // project / priority — override that field. No tokens leave any existing
    // values alone; !0 explicitly clears the priority.
    const assignId = projectId ?? (await materializeTagProject(createProjectName));
    // !0 maps to null — the explicit clear.
    const tier = priority === 0 ? null : priority;
    setItems((s) => {
      const patch: Partial<Item> = { text };
      if (assignId) patch.projectId = assignId;
      if (priority !== null) patch.priority = tier;
      const update = (list: Item[]) => list.map((i) => (i.id === id ? { ...i, ...patch } : i));
      return {
        today: update(s.today),
        daily: update(s.daily),
        // A priority token can move the row across tiers — re-apply the tier
        // ordering so it lands in its group immediately (identity when the
        // priority didn't change and the list is already sorted).
        backlog: sortBacklog(update(s.backlog)),
      };
    });
    await api.editItem(id, text);
    if (assignId) api.setItemProject(id, assignId);
    if (priority !== null) api.setItemPriority(id, tier);
  };

  // Soft-archive a task. With Show Hidden Tasks on, the row stays put flipped
  // to its dimmed hidden state (expiry computed locally so the chip is right
  // immediately); otherwise it leaves the list. Time-limited hides
  // auto-restore via the day-boundary sweep.
  const handleHide = async (id: string, section: Section, duration: HideDuration) => {
    if (showHiddenItems) {
      updateItemField(id, { hidden: true, hiddenUntil: hideExpiry(duration) });
    } else {
      setItems((s) => ({ ...s, [section]: s[section].filter((i) => i.id !== id) }));
    }
    await api.hideItem(id, duration);
  };

  // Restore a hidden row — it sheds its dimmed state and stays in place
  // (hidden rows only render when Show Hidden Tasks is on).
  const handleUnhide = async (id: string) => {
    updateItemField(id, { hidden: false });
    await api.unhideItem(id);
  };

  // Assign (or clear) an item's project. Housekeeping — not journal activity.
  const updateItemField = (id: string, patch: Partial<Item>) => {
    setItems((s) => {
      const upd = (list: Item[]) => list.map((i) => (i.id === id ? { ...i, ...patch } : i));
      return { today: upd(s.today), daily: upd(s.daily), backlog: upd(s.backlog) };
    });
  };

  const handleSetProject = async (id: string, projectId: string | null) => {
    updateItemField(id, { projectId });
    await api.setItemProject(id, projectId);
  };

  const handleSetReminder = async (id: string, remindAt: string | null) => {
    updateItemField(id, { remindAt });
    await api.setReminder(id, remindAt);
  };

  // Toggle the single active timer on `id`. Starting B auto-stops A (the
  // backend finalizes any open session first). Optimistic: show the timer with
  // ~0 elapsed immediately, then reconcile with the authoritative started_at.
  const handleToggleTimer = useCallback(async (id: string) => {
    if (activeTimer?.itemId === id) {
      setActiveTimer(null);
      try { await timersApi.stop(); }
      catch (e) { log.error("timer stop failed", e); }
      refreshTotals();
      return;
    }
    const item = [...items.today, ...items.daily, ...items.backlog].find((i) => i.id === id);
    setActiveTimer({ itemId: id, itemText: item?.text ?? "", startedAt: new Date().toISOString() });
    try {
      setActiveTimer(await timersApi.start(id));
    } catch (e) {
      log.error("timer start failed", e);
      setActiveTimer(null);
    }
    refreshTotals();
  }, [activeTimer, items, refreshTotals]);

  // Discard the open session entirely (don't save it) — for the "left it running
  // overnight" case where the elapsed is obviously wrong.
  const handleDiscardTimer = useCallback(async () => {
    setActiveTimer(null);
    try { await timersApi.discard(); }
    catch (e) { log.error("timer discard failed", e); }
    refreshTotals();
  }, [refreshTotals]);

  // Optimistic reorder/move for DnD. `newIndex` arrives in display space —
  // against the (possibly priority-filtered) list the user sees — so translate
  // it into the full-list index the backend re-indexes against. The anchor is
  // the row being dropped before, or the last displayed row for an
  // append-at-end drop; with no filter this is the identity mapping.
  const handleMoveItem = async (id: string, toSection: Section, newIndex: number) => {
    const display = displayItems[toSection];
    const anchor = display[newIndex] ?? display[display.length - 1];
    const fullIndex = anchor
      ? items[toSection].findIndex((i) => i.id === anchor.id) + (display[newIndex] ? 0 : 1)
      : items[toSection].length;
    setItems((s) => {
      const fromSection = (["today", "daily", "backlog"] as Section[]).find(
        (sec) => s[sec].some((i) => i.id === id),
      );
      if (!fromSection) return s;
      const moved = s[fromSection].find((i) => i.id === id);
      if (!moved) return s;
      if (fromSection === toSection) {
        const list = s[fromSection].filter((i) => i.id !== id);
        list.splice(fullIndex, 0, moved);
        return {
          ...s,
          [fromSection]: toSection === "backlog" ? settleBacklogDrop(list, id, fullIndex) : list,
        };
      }
      const fromList = s[fromSection].filter((i) => i.id !== id);
      const toList = [...s[toSection]];
      toList.splice(fullIndex, 0, moved);
      return {
        ...s,
        [fromSection]: fromList,
        [toSection]: toSection === "backlog" ? settleBacklogDrop(toList, id, fullIndex) : toList,
      };
    });
    await api.moveItem(id, toSection, fullIndex);
  };

  // ---- Search -----------------------------------------------------------
  // Flattened list of all displayed items for ⌘F. Built from live state so the
  // SearchMenu always reflects what's on screen.
  const searchHits: SearchHit[] = useMemo(
    () => ([
      ...renderItems.today.map((item) => ({ item, section: "today" as Section })),
      ...renderItems.daily.map((item) => ({ item, section: "daily" as Section })),
      ...renderItems.backlog.map((item) => ({ item, section: "backlog" as Section })),
    ]),
    [renderItems],
  );

  // Jump to a search hit: select it and scroll its row into view. The row is
  // identified by data-item-id, set on every ItemRow's root element.
  const jumpTo = useCallback((hit: SearchHit) => {
    setSelectedId(hit.item.id);
    requestAnimationFrame(() => {
      document.querySelector(`[data-item-id="${hit.item.id}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }, []);

  // Selecting a project in ⌘F's `#` mode narrows the main list to it; picking
  // the already-active project clears the filter — the same toggle rule as the
  // ⌘P priority tiers. Show Regular View clears it with everything else.
  const handleSelectProject = useCallback((id: string) => {
    setView("list");
    setProjectFilter((p) => (p === id ? null : id));
  }, []);

  // ---- Keyboard nav ----------------------------------------------------

  const allVisible = useMemo(
    () => [...renderItems.today, ...renderItems.daily, ...renderItems.backlog],
    [renderItems],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (view !== "list") return;
      const target = e.target as HTMLElement;
      const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA";

      if (typing) return;

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        moveSelection(1);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        moveSelection(-1);
      } else if (e.key === "Enter" && selectedId) {
        const item = allVisible.find((i) => i.id === selectedId);
        // Archived rows aren't actionable — completing one would silently
        // vanish it (done + hidden, invisible in every mode). Unhide first.
        if (item && !item.hidden) { e.preventDefault(); handleComplete(item.id, item.section); }
      } else if (e.key === "e" && selectedId) {
        e.preventDefault();
        setEditingId(selectedId);
      } else if ((e.key === "Backspace" || e.key === "Delete") && selectedId) {
        const item = allVisible.find((i) => i.id === selectedId);
        if (item) { e.preventDefault(); handleDelete(item.id, item.section); }
      } else if (e.key === "t" && selectedId) {
        const item = allVisible.find((i) => i.id === selectedId);
        if (item) { e.preventDefault(); handleToggleTimer(item.id); }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allVisible, selectedId, view, activeTimer]);

  const moveSelection = (delta: number) => {
    const idx = allVisible.findIndex((i) => i.id === selectedId);
    const next = idx === -1 ? 0 : Math.min(allVisible.length - 1, Math.max(0, idx + delta));
    setSelectedId(allVisible[next]?.id ?? null);
  };

  // ---- Render ----------------------------------------------------------

  return (
    <div className="app">
      <header className="header">
        {/* The list view carries the brand — "Live @ Faraz" is home, and every
            2 minutes it steps out to a random MASTHEAD_THEMES word and back
            (keyed so each swap fades in; see title-in in index.css). The
            journal view carries its own title. Always rendered — the timer
            chip carries no task-name text (tooltip only), so the two coexist
            on the 480px window. Below ~455px the media query in index.css
            hides the masthead. */}
        <span className="title" key={view === "journal" ? "journal" : liveAt}>
          {view === "journal" ? "Journal" : `Live @ ${liveAt}`}
        </span>
        <div className="header-right">
          {/* The running timer is always visible here — survives scrolling away
              from the timed row, and doubles as a "current focus" display.
              Pulse + elapsed only; the task name rides in the tooltip so the
              centered masthead never has to hide. Click to stop (keep the
              session); × discards it entirely. */}
          {activeTimer && (
            <div className="timer-chip" title="Timer running">
              <button
                className="timer-chip-main"
                onClick={() => handleToggleTimer(activeTimer.itemId)}
                title={`Stop timer (keep session) — ${activeTimer.itemText || "Timer"}`}
              >
                <span className="timer-chip-pulse" />
                <span className="timer-chip-elapsed">{formatLiveDuration(liveElapsed)}</span>
              </button>
              <button
                className="timer-chip-discard"
                onClick={handleDiscardTimer}
                title="Discard session (don't save)"
                aria-label="Discard timer"
              >×</button>
            </div>
          )}
          {/* ◐ toggles both hidden surfaces (tasks + notes) at once — the
              one-click archive peek over the ⌘P per-surface toggles. */}
          <button
            className={`icon-btn ${showHiddenItems || showHiddenNotes ? "active" : ""}`}
            onClick={() => {
              const next = !(showHiddenItems || showHiddenNotes);
              setShowHiddenItems(next);
              setShowHiddenNotes(next);
            }}
            title={showHiddenItems || showHiddenNotes ? "Hide hidden entries" : "Show hidden entries inline"}
            aria-label="Toggle hidden entries"
          >◐</button>
          <button
            className={`icon-btn ${view === "journal" ? "active" : ""}`}
            onClick={() => setView(view === "journal" ? "list" : "journal")}
            title={view === "journal" ? "Back to list" : "View journal"}
            aria-label="Toggle journal"
          >
            {view === "journal" ? "✕" : "≡"}
          </button>
        </div>
      </header>

      {/* Single scroll container — the whole body (notes + sections, or the
          journal) scrolls as one page. See AGENTS.md. */}
      <div className="scroll">
        {view === "list" ? (
          <>
            {/* Goals — the identity layer at the very top: horizon statements
                (timeless / long / short) that give the list its "why".
                Self-contained like Notes, outside the DnD area; ⌘P → Show/Hide
                Goals toggles it completely (persisted). Goals don't take part
                in the item visibility/priority/project filters — they're a
                separate surface, shown as-is. */}
            {goalsVisible && (
              <Goals projects={projects} onCreateProject={handleCreateProject} />
            )}
            {/* Notes — the lowest-friction capture surface, right under the
                goals. Lives above the DnD area so typing/pasting isn't a drag
                surface. Self-contained: owns its state, API, and persistence.
                With Show Hidden Notes on, hidden notes render inline (dimmed)
                instead of being excluded. */}
            {notesVisible && (
              <Notes hiddenFilter={showHiddenNotes ? "include" : "exclude"} />
            )}
            {(hiddenPriorities.length > 0 || projectFilter !== null) && allVisible.length === 0 && (
              <div className="empty">
                {projectFilter
                  ? `No tasks in ${projects.find((p) => p.id === projectFilter)?.name ?? "project"}.`
                  : "No tasks at the shown priorities."}
              </div>
            )}
            <SectionList
              items={renderItems}
              visible={sectionsVisible}
              projects={projects}
              selectedId={selectedId}
              editingId={editingId}
              onSelect={setSelectedId}
              onComplete={handleComplete}
              onDelete={handleDelete}
              onCommitEdit={handleCommitEdit}
              onStartEdit={setEditingId}
              onQuickAdd={handleCreate}
              onHide={handleHide}
              onUnhide={handleUnhide}
              onSetProject={handleSetProject}
              onCreateProject={handleCreateProject}
              onSetReminder={handleSetReminder}
              onMoveItem={handleMoveItem}
              activeTimerId={activeTimer?.itemId ?? null}
              liveElapsed={liveElapsed}
              timeTotals={timeTotals}
              onToggleTimer={handleToggleTimer}
            />
          </>
        ) : (
          <JournalView />
        )}
      </div>

      {/* Floating surfaces (modals/overlays) — always position:fixed, never
          inline. See AGENTS.md "Layout architecture". */}
      <SearchMenu
        open={searchOpen}
        hits={searchHits}
        projects={projects}
        activeProjectId={projectFilter}
        onClose={() => setSearchOpen(false)}
        onJump={jumpTo}
        onSelectProject={handleSelectProject}
      />
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />
      <UpdateOverlay
        status={updateStatus}
        onDismiss={() => setUpdateStatus(null)}
      />
      <MobileSyncSettings
        open={syncSettingsOpen}
        onClose={() => setSyncSettingsOpen(false)}
      />
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

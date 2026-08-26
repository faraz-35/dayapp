// App — the shell. Owns app-wide state (items, focus, view, zoom), effects
// (load, sweep tick, self-update events), and the global keyboard handler
// (⌘P, ⌘F, ⌘+/⌘-, j/k, the focus grammar — see "Keyboard nav" below).
// Everything else is delegated to focused components in ./components.
//
// Layout contract (see AGENTS.md "Layout architecture"): the header is pinned
// and a single `.scroll` wrapper scrolls the whole body. Never add a second
// `overflow-y: auto` to a child — that's what caused the split-scroll bug.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, backupApi, demoApi, formatLiveDuration, hideExpiry, localDateStr, parseItemTags, projectsApi, syncApi, timersApi, type ActiveTimer, type EntryKind, type HideDuration, type Item, type Project, type Section } from "./lib";
import { log } from "./log";
import Notes from "./Notes";
import Goals from "./Goals";
import Quotes from "./Quotes";
import Journal from "./Journal";
import SectionList from "./components/SectionList";
import AnalyticsView from "./AnalyticsView";
import CommandPalette, { type Command } from "./CommandPalette";
import SearchMenu, { type SearchHit } from "./components/SearchMenu";
import UpdateOverlay from "./UpdateOverlay";
import MobileView from "./MobileView";
import MobileSyncSettings from "./MobileSyncSettings";
import KeyboardHelp from "./KeyboardHelp";
import { clickKbButton, focusCapture, focusGoalEditor, focusNoteEditor, goalIdAt, noteIdAt, popoverOpen, scrollIntoViewEl } from "./focusNav";

type View = "list" | "analytics" | "journal";

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

// The quote screensaver's threshold: two minutes of focused stillness (no
// key, click, pointer movement, or scroll) summons the quote modal unprompted.
const SCREENSAVER_IDLE_MS = 120_000;

// The address prefixes of the focus grammar: n (notes + captures), t/d
// (Today/Daily rows), b (Backlog rows, two digits: tier then index), g
// (goals). Typed directly, no mode — see the key handler below.
const ADDRESS_KEYS = new Set(["n", "t", "d", "b", "g"]);

// Free-mode scroll step (px) for j/k + ↑/↓ when nothing is focused. Read in
// .scroll's local space, so zoom scales it with the content — the step is
// always ~4 rows regardless of zoom level.
const SCROLL_STEP = 120;

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
  // The keyboard focus grammar's non-item targets: exactly one thing is
  // focused app-wide — a row (selectedId), a note, or a goal — and the digits
  // and `e` act on whichever it is. Notes/Goals own their data; App owns only
  // the focus id, passed down for the highlight.
  const [focusNoteId, setFocusNoteId] = useState<string | null>(null);
  const [focusGoalId, setFocusGoalId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // The row whose details body is expanded (⋯ hover button, the ⌄ hint, or
  // digit 5 on the focused row). Session-only — transient inspection, like editingId.
  const [detailsOpenId, setDetailsOpenId] = useState<string | null>(null);
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
  // ⌘P "Show/Hide Priority N Notes" — the notes' own three per-tier toggles,
  // independent of the task tiers (the same per-surface independence as Hidden
  // Notes vs Hidden Tasks). Notes group by tier Backlog-style; hiding a tier
  // drops that group (and its divider).
  const [hiddenNotePriorities, setHiddenNotePriorities] = useState<(1 | 2 | 3)[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("dayapp-hidden-note-priorities") ?? "[]");
      return [1, 2, 3].filter((n) => raw.includes(n)) as (1 | 2 | 3)[];
    } catch {
      return [];
    }
  });
  // ⌘P "Enter/Exit Focus Mode" — a lens over the working view, not a set of
  // toggle mutations: P1 notes, Today, Daily, P1 Backlog only (Goals hidden —
  // focus mode is stricter than the default working view). Exiting restores
  // whatever the toggles were. Persisted like every layout surface; Show
  // Default View exits it.
  const [focusMode, setFocusMode] = useState(
    () => localStorage.getItem("dayapp-focus-mode") === "1",
  );
  // ⌘P "Show/Hide Agent Tasks" — hide the 🤖-marked rows to focus on the ones
  // that are Faraz's own. Persisted like the other layout toggles; default on
  // (agent rows are normal tasks until he says otherwise).
  const [agentTasksVisible, setAgentTasksVisible] = useState(
    () => localStorage.getItem("dayapp-agent-tasks-visible") !== "0",
  );
  // ⌘P "Enable/Disable Quote Screensaver" — two minutes of focused stillness
  // summons the quote modal (the idle watcher below). Persisted like the
  // layout toggles; default on. With an empty pool it can't fire, and the
  // palette entry hides alongside "Show a Quote".
  const [quoteScreensaver, setQuoteScreensaver] = useState(
    () => localStorage.getItem("dayapp-quote-screensaver") !== "0",
  );
  // The quote moment (⌘P → Show a Quote, or the idle screensaver below): App
  // owns the open boolean (the floating-surface gate in the key handler needs
  // it) and the pool size (reported up from Quotes so the palette entries
  // hide while empty). Quotes.tsx owns the rest — pick, linger, dismissal.
  const [quoteOpen, setQuoteOpen] = useState(false);
  // Whether the open modal arrived by stillness rather than ⌘P — a
  // screensaver open lingers until input instead of LINGER_MS.
  const [quoteIdle, setQuoteIdle] = useState(false);
  // When the modal was summoned (epoch ms). The keystroke that RUNS the
  // palette command also bubbles on to the window key handler a moment later
  // — by then quoteOpen has committed true, so without a grace window the
  // summoning Enter/click dismisses the modal it just opened (born and killed
  // in one event; the "modal never appears" bug).
  const quoteOpenedAt = useRef(0);
  const openQuote = useCallback((idle = false) => {
    quoteOpenedAt.current = Date.now();
    setQuoteIdle(idle);
    setQuoteOpen(true);
  }, []);
  const [quoteCount, setQuoteCount] = useState(0);
  // Stable identity: Quotes' linger timer depends on onClose, and App
  // re-renders every second while a timer runs — an inline arrow would reset
  // the 45s clock on each tick.
  const closeQuote = useCallback(() => {
    setQuoteOpen(false);
    setQuoteIdle(false);
  }, []);
  // The quote pool's refresh trigger: bumped on demo-mode swaps and whenever
  // a ##q capture lands (Notes' onEntryRouted) or a quote changes in the
  // Journal view. Quotes.tsx re-fetches on it — no polling.
  const [quotesVersion, setQuotesVersion] = useState(0);
  // ⌘F "@agent/my" — narrow the list to the agent's tasks or Faraz's own;
  // null = off. Session-only like the project filter (a search-shaped focus).
  const [agentFilter, setAgentFilter] = useState<"agent" | "mine" | null>(null);
  // ⌘F "#project" — narrow the list to one project; null = off. The one
  // session-only filter (a search-shaped focus, not a layout preference);
  // composed with the priority tier in displayItems.
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
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

  // Capture a db snapshot (⌘B / ⌘P → Backups: Capture Now). The backend
  // refuses in demo mode — backups protect the real db only.
  const captureBackup = useCallback(() => {
    backupApi.capture()
      .then((path) => {
        const name = path.split("/").pop() ?? path;
        log.info(`backup: captured ${name}`);
        showToast(`Backup saved: ${name}`);
      })
      .catch((e) => { log.error("backup: capture failed", e); showToast(`Backup failed: ${e}`); });
  }, [showToast]);
  // Demo mode (⌘P → Enter/Exit): the backend swapped the whole database to the
  // disposable demo file. Session-only — the initial query catches the first-run
  // tour, the "demo-mode" event catches toggles/resets. `dataEpoch` bumps on
  // every swap so the self-contained surfaces (Notes, Goals) reload too.
  const [demoMode, setDemoMode] = useState(false);
  const [dataEpoch, setDataEpoch] = useState(0);
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
    // Demo mode is session-only, so the backend decides — this catches the
    // first-run tour before the first paint settles.
    demoApi.active().then(setDemoMode).catch((e) => log.warn("demo mode query failed", e));
    // Re-check the day boundary while the app stays open. If local time crosses
    // midnight, run the sweep so Today items fall to Backlog without a relaunch.
    // The same tick drains the phone's capture inbox, so a capture made while
    // walking lands within a minute of the Mac app being open — except in demo
    // mode, where the phone's inbox waits (its captures belong to the real db).
    const tick = setInterval(() => {
      api.runSweep().then(refresh).catch((e) => log.warn("sweep tick failed", e));
      // The open session row is the timer's source of truth — reconcile the
      // chip with CLI writes (--start/--complete from an SSH session) that the
      // GUI's state never saw.
      timersApi.active().then(setActiveTimer).catch((e) => log.warn("active timer reconcile failed", e));
      if (!demoMode) {
        ingestRef.current()
          .then((n) => { if (n > 0) refresh(); })
          .catch((e) => log.warn("sync: capture pull failed", e));
      }
    }, 60_000);
    // One pull shortly after launch (captures queued while the app was closed).
    const first = setTimeout(() => {
      if (demoMode) return;
      ingestRef.current()
        .then((n) => { if (n > 0) refresh(); })
        .catch((e) => log.warn("sync: capture pull failed", e));
    }, 4_000);
    return () => { clearInterval(tick); clearTimeout(first); };
  }, [refresh, demoMode]);

  // A demo-mode toggle (or reset) swapped the entire database under the app:
  // re-pull everything and drop every id-scoped UI state — selection, focus,
  // open editor, project filter — since ids from the other db don't exist here.
  // The masthead (demoMode) and the ⌘P entries follow from the same flag.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{ active: boolean }>("demo-mode", (e) => {
        setDemoMode(e.payload.active);
        setSelectedId(null);
        setFocusNoteId(null);
        setFocusGoalId(null);
        setEditingId(null);
        setDetailsOpenId(null);
        setProjectFilter(null);
        setDataEpoch((n) => n + 1);
        setQuotesVersion((n) => n + 1);
        refresh();
        // The active timer lives in whichever db is now active (a real timer
        // left running stays honest across the whole demo session).
        timersApi.active().then(setActiveTimer).catch((err) => log.warn("active timer load failed", err));
      });
    })();
    return () => { unlisten?.(); };
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
    localStorage.setItem("dayapp-hidden-note-priorities", JSON.stringify(hiddenNotePriorities));
    localStorage.setItem("dayapp-focus-mode", focusMode ? "1" : "0");
    localStorage.setItem("dayapp-agent-tasks-visible", agentTasksVisible ? "1" : "0");
    localStorage.setItem("dayapp-quote-screensaver", quoteScreensaver ? "1" : "0");
    // Retired keys: the single-tier "only" filter era, and the rotating
    // quote line the modal replaced — one-time cleanups.
    localStorage.removeItem("dayapp-priority");
    localStorage.removeItem("dayapp-quotes-visible");
  }, [goalsVisible, notesVisible, sectionsVisible, showHiddenItems, showHiddenNotes, hiddenPriorities, hiddenNotePriorities, focusMode, agentTasksVisible, quoteScreensaver]);

  // Brand rotation: every 2 minutes toggle home ↔ a random theme. The tick
  // runs in every view; the analytics title simply ignores it.
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

  // ---- Quote screensaver --------------------------------------------------
  // SCREENSAVER_IDLE_MS of focused stillness summons the quote modal — the
  // screensaver idiom, not a push notification: it only arrives when nothing
  // is happening, and any key or click ends it through the modal's existing
  // dismissal (which preventDefaults, so the waking key can't also type into
  // whatever sat beneath). The clock only runs while the window is focused —
  // away time never counts (Faraz's call: it's for sitting with the app, not
  // having left it; blur restarts the clock) — and only real user input
  // resets it. App-driven re-renders (the timer's 1s tick, the 60s sweep, the
  // masthead rotation above) correctly don't.
  const lastInputAt = useRef(Date.now());
  useEffect(() => {
    const bump = () => { lastInputAt.current = Date.now(); };
    const events = ["keydown", "pointerdown", "mousemove", "wheel"] as const;
    window.addEventListener("blur", bump);
    for (const e of events) window.addEventListener(e, bump, { passive: true });
    return () => {
      window.removeEventListener("blur", bump);
      for (const e of events) window.removeEventListener(e, bump);
    };
  }, []);
  useEffect(() => {
    if (!quoteScreensaver) return;
    const id = setInterval(() => {
      if (
        quoteOpen || quoteCount === 0 ||
        paletteOpen || searchOpen || helpOpen || syncSettingsOpen || updateStatus ||
        !document.hasFocus() ||
        Date.now() - lastInputAt.current < SCREENSAVER_IDLE_MS
      ) return;
      openQuote(true);
    }, 5_000);
    return () => clearInterval(id);
  }, [quoteScreensaver, quoteOpen, quoteCount, paletteOpen, searchOpen, helpOpen, syncSettingsOpen, updateStatus, openQuote]);

  // What the user sees: items narrowed by the ⌘P hidden priority tiers, the ⌘P
  // agent-tasks toggle, and/or the ⌘F project/agent filters, if any. Hiding a
  // tier removes just that tier's rows — unmarked rows stay, and each tier is
  // independent. Focus Mode adds its lens here: the Backlog narrows to P1
  // (Today/Daily stay whole — the day's list is the point of the mode).
  // Mutations read the full `items`, and DnD indexes map back to full-list
  // space in handleMoveItem.
  const displayItems = useMemo<Record<Section, Item[]>>(() => {
    if (
      hiddenPriorities.length === 0 && projectFilter === null &&
      agentTasksVisible && agentFilter === null && !focusMode
    ) return items;
    const matches = (i: Item) =>
      (i.priority === null || !hiddenPriorities.includes(i.priority)) &&
      (projectFilter === null || i.projectId === projectFilter) &&
      (agentTasksVisible || !i.assignedToAgent) &&
      (agentFilter === null || (agentFilter === "agent") === i.assignedToAgent) &&
      (!focusMode || i.section !== "backlog" || i.priority === 1);
    return {
      today: items.today.filter(matches),
      daily: items.daily.filter(matches),
      backlog: items.backlog.filter(matches),
    };
  }, [items, hiddenPriorities, projectFilter, agentTasksVisible, agentFilter, focusMode]);

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
      // sections + Notes + agent tasks shown, focus mode off — and Goals
      // hidden (the default working view is the plain task list).
      run: () => {
        setView("list");
        setShowHiddenItems(false);
        setShowHiddenNotes(false);
        setHiddenPriorities([]);
        setHiddenNotePriorities([]);
        setFocusMode(false);
        setProjectFilter(null);
        setAgentTasksVisible(true);
        setAgentFilter(null);
        setSectionsVisible({ today: true, daily: true, backlog: true });
        setNotesVisible(true);
        setGoalsVisible(false);
      },
    },
    // The ##q moment — one quote on a dim backdrop, deliberately summoned
    // (rarity is what gives it weight; the old always-on line became
    // wallpaper). Sits second in the palette, where the line's Show/Hide
    // toggle lived, so the ⌘P muscle memory finds it — and it's on the first
    // screen, not buried below the fold. Hidden while the pool is empty:
    // quotes have no management surface, so an empty pool means nothing to
    // summon.
    ...(quoteCount > 0 ? [
      {
        id: "show-quote",
        label: "Show a Quote",
        hint: "a moment with one of your ##q captures",
        run: () => openQuote(),
      },
      {
        // The idle twin: 2 minutes of focused stillness and a quote comes to
        // you, lingering until any key or click. Hides with the empty pool
        // like Show a Quote — nothing to show, nothing to toggle.
        id: "quote-screensaver",
        label: quoteScreensaver ? "Disable Quote Screensaver" : "Enable Quote Screensaver",
        hint: "after 2 min of stillness, while focused",
        run: () => setQuoteScreensaver((v) => !v),
      },
    ] : []),
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
      // touches the others (or the unmarked rows). The "Tasks" suffix pairs
      // with the Notes toggles below now that both axes exist.
      label: hiddenPriorities.includes(n) ? `Show Priority ${n} Tasks` : `Hide Priority ${n} Tasks`,
      hint: "▮".repeat(4 - n),
      run: () => {
        setView("list");
        setHiddenPriorities((h) =>
          h.includes(n) ? h.filter((p) => p !== n) : [...h, n],
        );
      },
    })),
    ...([1, 2, 3] as const).map((n) => ({
      id: `notes-prio-${n}`,
      // The notes' own per-tier toggles — Notes groups by tier like the
      // Backlog, and hiding a tier drops that whole group. Independent of the
      // task tiers above (Hidden Notes ≠ Hidden Tasks, same rule).
      label: hiddenNotePriorities.includes(n) ? `Show Priority ${n} Notes` : `Hide Priority ${n} Notes`,
      hint: "▮".repeat(4 - n),
      run: () => {
        setView("list");
        setHiddenNotePriorities((h) =>
          h.includes(n) ? h.filter((p) => p !== n) : [...h, n],
        );
      },
    })),
    {
      // Focus Mode — the deep-work lens over the working view: P1 notes,
      // Today, Daily, and P1 Backlog only (Goals hidden too). A lens, not a
      // batch of toggle mutations: exiting restores the toggles untouched.
      id: "toggle-focus",
      label: focusMode ? "Exit Focus Mode" : "Enter Focus Mode",
      hint: "P1 notes + Today + Daily + P1 Backlog",
      run: () => { setView("list"); setFocusMode((v) => !v); },
    },
    {
      id: "toggle-agent-tasks",
      // The delegation axis: 🤖-marked rows are the agent's queue. Hiding them
      // leaves just the rows that need Faraz — the inverse focus of ⌘F's
      // "@agent" filter, which narrows *to* the queue.
      label: agentTasksVisible ? "Hide Agent Tasks" : "Show Agent Tasks",
      hint: "🤖 marked",
      run: () => { setView("list"); setAgentTasksVisible((v) => !v); },
    },
    {
      // Demo mode: the backend swaps to the disposable demo db and emits
      // "demo-mode", which re-pulls everything and swaps the masthead. The
      // state change rides the event — run() only fires the toggle.
      id: "demo-toggle",
      label: demoMode ? "Exit Demo Mode" : "Enter Demo Mode",
      hint: demoMode ? "back to your real data" : "sample data — your db untouched",
      run: () => {
        setView("list");
        const toggle = demoMode ? demoApi.exit : demoApi.enter;
        toggle().catch((e) => log.error("demo toggle failed", e));
      },
    },
    // Demo-only: restore the sample dataset (re-seeded relative to today, so a
    // reset also freshens a demo whose history has aged or drifted).
    ...(demoMode ? [{
      id: "demo-reset",
      label: "Reset Demo Data",
      hint: "restore the sample dataset",
      run: () => {
        demoApi.reset().catch((e) => log.error("demo reset failed", e));
      },
    }] : []),
    // Mobile sync belongs to the real db — hide its entries while demo mode is
    // active (the backend gates deploy/pull/config hard as well).
    ...(demoMode ? [] : [
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
      // Backups of the real db — hidden in demo mode like the mobile entries
      // (the backend gate refuses regardless; capture_backup bails).
      {
        id: "backup-capture",
        label: "Backups: Capture Now",
        hint: "snapshot the db (⌘B)",
        run: captureBackup,
      },
      {
        id: "backup-reveal",
        label: "Backups: Reveal Folder",
        hint: "in Finder",
        run: () => backupApi.reveal().catch((e) => log.error("backup: reveal failed", e)),
      },
    ]),
    { id: "view-analytics", label: "View Analytics", run: () => setView("analytics") },
    { id: "view-journal", label: "View Journal", run: () => setView("journal") },
    {
      id: "keyboard-help",
      label: "Keyboard Shortcuts",
      hint: "the focus grammar",
      run: () => setHelpOpen(true),
    },
    {
      id: "update",
      label: "Update DayApp",
      hint: "rebuild from source",
      run: startUpdate,
    },
  ], [startUpdate, refresh, showToast, captureBackup, goalsVisible, notesVisible, sectionsVisible, showHiddenItems, showHiddenNotes, hiddenPriorities, hiddenNotePriorities, focusMode, agentTasksVisible, quoteScreensaver, quoteCount, demoMode]);

  // ⌘P toggles the palette; ⌘F opens search; ⌘+/⌘- zoom the whole UI in/out
  // (⌘0 resets); ⌘B captures a db backup. All intercept globally (they're
  // modifier combos, so they don't interfere with typing in a field). Opening
  // the palette or search also closes the quote modal — it sits above both in
  // z-order, so leaving it open would cover the surface being summoned.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "p") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        setQuoteOpen(false);
      } else if (e.key === "f") {
        e.preventDefault();
        setSearchOpen(true);
        setQuoteOpen(false);
      } else if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        setZoom((z) => clampZoom(z + ZOOM_STEP));
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setZoom((z) => clampZoom(z - ZOOM_STEP));
      } else if (e.key === "0") {
        e.preventDefault();
        setZoom(1);
      } else if (e.key === "b") {
        e.preventDefault();
        captureBackup();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [captureBackup]);

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

  // Notes reports a ##j/##q capture it routed to the entries table. Only
  // quotes matter here — they're the entry kind App surfaces (the quote
  // modal), so its pool re-fetches; journal entries belong to the Journal
  // view, which fetches fresh on every mount.
  const handleEntryRouted = useCallback((kind: EntryKind) => {
    if (kind === "quote") setQuotesVersion((n) => n + 1);
  }, []);

  // Rename from the ⌘F `#` picker. Optimistic: every label (item rows, note
  // cards, goal rows) renders through this state, so the new name lands
  // everywhere at once; the 60s tick reconciles a failed write.
  const handleRenameProject = useCallback((id: string, name: string) => {
    setProjects((ps) => ps.map((p) => (p.id === id ? { ...p, name } : p)));
    projectsApi.rename(id, name).catch((err) => log.warn("rename project failed", err));
  }, []);

  // Delete from the ⌘F `#` picker: unlinks, never deletes rows. The backend
  // nulls project_id on items/goals/notes in one transaction — mirrored here
  // (labels also die with the projects-list lookup). Clearing the filter when
  // it pointed here keeps the list from narrowing to a ghost project.
  const handleDeleteProject = useCallback((id: string) => {
    setProjects((ps) => ps.filter((p) => p.id !== id));
    setItems((s) => ({
      today: s.today.map((i) => (i.projectId === id ? { ...i, projectId: null } : i)),
      daily: s.daily.map((i) => (i.projectId === id ? { ...i, projectId: null } : i)),
      backlog: s.backlog.map((i) => (i.projectId === id ? { ...i, projectId: null } : i)),
    }));
    setProjectFilter((f) => (f === id ? null : f));
    projectsApi.delete(id).catch((err) => log.warn("delete project failed", err));
  }, []);

  const handleCreate = async (section: Section, raw: string) => {
    // Resolve `#tag` → project, `!1..3` → priority, and `@` → agent assignment
    // on capture (e.g. "fix bug #day !2 @" → dayapp project, priority 2,
    // agent-owned), stripping the tokens from the text. Assignment is
    // housekeeping, so it happens after the item exists.
    const { text, projectId, createProjectName, priority, agent } = parseItemTags(raw, projects);
    const item = await api.createItem(text, section);
    const assignId = projectId ?? (await materializeTagProject(createProjectName));
    // !0 ("clear") is a no-op at capture — a fresh item has no priority yet.
    // Same for @0: fresh rows start unassigned.
    const tier = priority === 0 ? null : priority;
    const patch: Partial<Item> = {};
    if (assignId) patch.projectId = assignId;
    if (tier !== null) patch.priority = tier;
    if (agent === true) patch.assignedToAgent = true;
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
    if (agent === true) api.setItemAgent(item.id, true);
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
    const { text, projectId, createProjectName, priority, agent } = parseItemTags(raw, projects);
    setEditingId(null);
    if (!text) return;
    // Apply the stripped text, and — only if a token resolved or created a
    // project / priority / agent assignment — override that field. No tokens
    // leave any existing values alone; !0 / @0 explicitly clear.
    const assignId = projectId ?? (await materializeTagProject(createProjectName));
    // !0 maps to null — the explicit clear.
    const tier = priority === 0 ? null : priority;
    setItems((s) => {
      const patch: Partial<Item> = { text };
      if (assignId) patch.projectId = assignId;
      if (priority !== null) patch.priority = tier;
      if (agent !== null) patch.assignedToAgent = agent;
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
    if (agent !== null) api.setItemAgent(id, agent);
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

  // Set the task's details body (the spec / agent prompt). Content like a
  // note save — optimistic patch + fire; the body debounces its own saves.
  const handleSetDetails = async (id: string, details: string) => {
    updateItemField(id, { details });
    await api.setItemDetails(id, details);
  };

  const handleToggleDetails = useCallback((id: string) => {
    setDetailsOpenId((cur) => (cur === id ? null : id));
  }, []);

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
      // Crossing sections: patch the row's own fields to the destination so
      // section-derived rendering is right immediately — slot 1's verb (▶ vs
      // ↑), the priority bars, the reminder chip — not at the next 60s
      // refresh. Mirrors move_item's backend writes exactly, including the
      // reminder clear on leaving the Backlog.
      const migrated =
        fromSection === toSection
          ? moved
          : fromSection === "backlog"
            ? { ...moved, section: toSection, remindAt: null }
            : { ...moved, section: toSection };
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
      toList.splice(fullIndex, 0, migrated);
      return {
        ...s,
        [fromSection]: fromList,
        [toSection]: toSection === "backlog" ? settleBacklogDrop(toList, id, fullIndex) : toList,
      };
    });
    await api.moveItem(id, toSection, fullIndex);
  };

  // Send a Backlog row to the end of Today — the deliberate "pull this into my
  // day" verb (slot 1 on Backlog rows, where Today/Daily rows carry ▶). Rides
  // the drag machinery end to end: optimistic append at Today's end, logged
  // `moved`, and any pending reminder cleared by move_item.
  const handlePromote = (id: string) => {
    handleMoveItem(id, "today", displayItems.today.length);
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
  // ⌘P priority tiers. The `@` mode works identically over the delegation axis:
  // "agent" narrows to the 🤖 queue, "mine" to Faraz's own rows. Show Regular
  // View clears both with everything else.
  const handleSelectProject = useCallback((id: string) => {
    setView("list");
    setProjectFilter((p) => (p === id ? null : id));
  }, []);

  const handleSelectAgent = useCallback((mode: "agent" | "mine") => {
    setView("list");
    setAgentFilter((f) => (f === mode ? null : mode));
  }, []);

  // ---- Keyboard nav + the focus grammar ----------------------------------
  //
  // The grammar (⌘P → Keyboard Shortcuts is the reference card):
  //   nn / nt / nd / nb   focus the Notes / Today / Daily / Backlog capture
  //   t1-9 / d1-9         focus a Today / Daily row
  //   b11-49              focus a Backlog row (tier 4 = unprioritized)
  //   n1-9 / g1-9         focus a note / goal
  //   1-6 / 1-3           fire the focused thing's buttons, in visual order
  //   e                   edit the focused thing
  //   j/k, ↑/↓            walk the rows; nothing focused → scroll the page
  //   Esc                 editing → focused → nothing — digits are inert
  //                       unfocused, so a stray 1-6 can't do anything unseen
  // Exactly one thing is focused app-wide (a row, a note, or a goal). The
  // first key of any address clears focus, so a digit typed mid-sequence has
  // no target; the grammar is fixed-length, so there are no timeouts.

  const allVisible = useMemo(
    () => [...renderItems.today, ...renderItems.daily, ...renderItems.backlog],
    [renderItems],
  );

  // The half-typed address. Nothing renders from it; the handler consumes
  // exactly one following key (`b` re-arms once for its tier digit). Modifier
  // combos and leaving the list view cancel it.
  const pendingAddr = useRef("");

  const clearFocus = useCallback(() => {
    setSelectedId(null);
    setFocusNoteId(null);
    setFocusGoalId(null);
  }, []);

  const focusItem = useCallback((id: string) => {
    setSelectedId(id);
    setFocusNoteId(null);
    setFocusGoalId(null);
    scrollIntoViewEl(document.querySelector(`[data-item-id="${id}"]`));
  }, []);

  const focusNote = useCallback((id: string) => {
    setSelectedId(null);
    setFocusGoalId(null);
    setFocusNoteId(id);
    scrollIntoViewEl(document.querySelector(`[data-note-id="${id}"]`));
  }, []);

  const focusGoal = useCallback((id: string) => {
    setSelectedId(null);
    setFocusNoteId(null);
    setFocusGoalId(id);
    scrollIntoViewEl(document.querySelector(`[data-goal-id="${id}"]`));
  }, []);

  // Resolve a complete address sequence. Row indexes come from renderItems
  // (filters and toggled-off sections compose for free); notes and goals come
  // from the DOM (Notes/Goals own their lists — DOM order is visual order).
  // An address that lands nowhere (t9 with three rows, a hidden section's
  // capture) is a silent no-op.
  const resolveAddress = (seq: string) => {
    const [p, a, b] = seq;
    const n = Number(a);
    if (p === "n") {
      if (a === "n") focusCapture("notes");
      else if (a === "t") focusCapture("today");
      else if (a === "d") focusCapture("daily");
      else if (a === "b") focusCapture("backlog");
      else if (n >= 1 && n <= 9) {
        const id = noteIdAt(n);
        if (id) focusNote(id);
      }
    } else if ((p === "t" || p === "d") && n >= 1 && n <= 9) {
      const item = renderItems[p === "t" ? "today" : "daily"][n - 1];
      if (item) focusItem(item.id);
    } else if (p === "g" && n >= 1 && n <= 9) {
      const id = goalIdAt(n);
      if (id) focusGoal(id);
    } else if (p === "b" && n >= 1 && n <= 4) {
      const idx = Number(b);
      if (!(idx >= 1 && idx <= 9)) {
        // Tier digit in, index still coming — hold the sequence open.
        pendingAddr.current = seq;
        return;
      }
      const tier = n === 4 ? null : (n as 1 | 2 | 3);
      const item = renderItems.backlog.filter((i) => (i.priority ?? null) === tier)[idx - 1];
      if (item) focusItem(item.id);
    }
  };

  // The mouse follows the same one-focused-thing rule as the grammar:
  // clicking a row, note, or goal makes it the digits' target, exactly as
  // addressing it would. Clicks elsewhere leave focus alone — Esc is the
  // explicit way down the ladder.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      const noteId = el?.closest("[data-note-id]")?.getAttribute("data-note-id");
      if (noteId) {
        setSelectedId(null); setFocusGoalId(null); setFocusNoteId(noteId);
        return;
      }
      const goalId = el?.closest("[data-goal-id]")?.getAttribute("data-goal-id");
      if (goalId) {
        setSelectedId(null); setFocusNoteId(null); setFocusGoalId(goalId);
        return;
      }
      const itemId = el?.closest("[data-item-id]")?.getAttribute("data-item-id");
      if (itemId) {
        setFocusNoteId(null); setFocusGoalId(null); setSelectedId(itemId);
      }
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // A floating surface owns the keys while it's open. Its focused input
      // already covered typing; this also catches a blurred input behind a
      // backdrop and freezes the page under the update overlay's swap.
      if (helpOpen || syncSettingsOpen || paletteOpen || searchOpen || updateStatus) {
        pendingAddr.current = "";
        return;
      }
      // The quote modal owns the keys while it's open — it has no inputs, so
      // any key means "done thinking" and dismisses (see the grace notes
      // inside).
      if (quoteOpen) {
        pendingAddr.current = "";
        // Bare modifier chords are prefixes (⌘P/⌘F still work via their own
        // listener), and the first moments belong to the summoning event's
        // own tail — neither dismisses. Every other key does.
        const chordPrefix = e.metaKey || e.ctrlKey || e.altKey || e.key === "Shift";
        const isSummonTail = Date.now() - quoteOpenedAt.current <= 250;
        if (!chordPrefix && !isSummonTail) {
          e.preventDefault();
          setQuoteOpen(false);
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) {
        pendingAddr.current = "";
        return;
      }
      const target = e.target as HTMLElement;
      const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA";

      if (typing) return;

      // A pending address consumes exactly the next key — the first key of
      // the sequence already cleared focus, so a digit here can never fire a
      // button on the thing that had it.
      const addr = pendingAddr.current;
      if (addr) {
        e.preventDefault();
        pendingAddr.current = "";
        resolveAddress(addr + e.key);
        return;
      }

      // j/k + ↑/↓: with something focused they walk the rows (clamped at
      // the ends — Esc or a new address is the only way out of focus mode).
      // With nothing focused — the Esc ladder's bottom rung — they scroll
      // the page instead: a view-only verb, so free mode gains a use
      // without anything being able to happen unseen. Works in every view
      // (the analytics page has no focusable rows); an open popover owns its keys,
      // so the page never slides under a menu.
      const down = e.key === "j" || e.key === "ArrowDown";
      const up = e.key === "k" || e.key === "ArrowUp";
      if (down || up) {
        e.preventDefault();
        if (selectedId === null && focusNoteId === null && focusGoalId === null) {
          if (!popoverOpen()) {
            document.querySelector(".scroll")?.scrollBy({
              top: down ? SCROLL_STEP : -SCROLL_STEP,
              behavior: "smooth",
            });
          }
        } else {
          setFocusNoteId(null);
          setFocusGoalId(null);
          moveSelection(down ? 1 : -1);
        }
        return;
      }

      if (view !== "list") {
        pendingAddr.current = "";
        return;
      }

      if (e.key === "Enter" && selectedId) {
        const item = allVisible.find((i) => i.id === selectedId);
        // Archived rows aren't actionable — completing one would silently
        // vanish it (done + hidden, invisible in every mode). Unhide first.
        if (item && !item.hidden) { e.preventDefault(); handleComplete(item.id, item.section); }
      } else if (e.key === "e") {
        // The one edit verb, on whichever thing is focused.
        if (selectedId) { e.preventDefault(); setEditingId(selectedId); }
        else if (focusNoteId) { e.preventDefault(); focusNoteEditor(focusNoteId); }
        else if (focusGoalId) { e.preventDefault(); focusGoalEditor(focusGoalId); }
      } else if (e.key === "Escape") {
        // Ladder rung focused → nothing. (editing → focused is each edit
        // surface's own Escape — cancel/flush and blur, landing on the thing
        // still focused here.) An open duration/project/reminder popover
        // closes itself on this same press; keep the focus under it.
        if (popoverOpen()) return;
        clearFocus();
      } else if (/^[1-9]$/.test(e.key)) {
        // Fire the focused thing's Nth button (data-kb markers, visual
        // order). Nothing focused → nothing happens, by design.
        const scope = selectedId
          ? document.querySelector(`[data-item-id="${selectedId}"]`)
          : focusNoteId
            ? document.querySelector(`[data-note-id="${focusNoteId}"]`)
            : focusGoalId
              ? document.querySelector(`[data-goal-id="${focusGoalId}"]`)
              : null;
        if (scope) { e.preventDefault(); clickKbButton(scope, Number(e.key)); }
      } else if (ADDRESS_KEYS.has(e.key)) {
        // Address prefix. Clears focus first — the user's safety rule — then
        // waits for the one or two keys that complete it.
        e.preventDefault();
        clearFocus();
        pendingAddr.current = e.key;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allVisible, selectedId, focusNoteId, focusGoalId, view, helpOpen, syncSettingsOpen, paletteOpen, searchOpen, quoteOpen, updateStatus, renderItems, activeTimer]);

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
            analytics view carries its own title. Always rendered — the timer
            chip carries no task-name text (tooltip only), so the two coexist
            on the 480px window. Below ~455px the media query in index.css
            hides the masthead.

            Demo mode outranks both: the masthead reads "Live @ Demo" in every
            view while the disposable demo db is active — the one unmissable
            (but calm) signal of which data is on screen. */}
        <span className="title" key={demoMode ? "demo" : view === "list" ? liveAt : view}>
          {demoMode ? "Live @ Demo" : view === "analytics" ? "Analytics" : view === "journal" ? "Journal" : `Live @ ${liveAt}`}
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
            className={`icon-btn ${view === "analytics" ? "active" : ""}`}
            onClick={() => setView(view === "analytics" ? "list" : "analytics")}
            title={view === "analytics" ? "Back to list" : "View analytics"}
            aria-label="Toggle analytics"
          >
            {view === "analytics" ? "✕" : "≡"}
          </button>
          {/* ¶ — the Journal view's door (the written word; Analytics keeps
              the numbers). Same per-button toggle as ≡: the active view's
              button reads ✕ and returns to the list. */}
          <button
            className={`icon-btn ${view === "journal" ? "active" : ""}`}
            onClick={() => setView(view === "journal" ? "list" : "journal")}
            title={view === "journal" ? "Back to list" : "View journal"}
            aria-label="Toggle journal"
          >
            {view === "journal" ? "✕" : "¶"}
          </button>
        </div>
      </header>

      {/* Single scroll container — the whole body (notes + sections, or the
          analytics page) scrolls as one page. See AGENTS.md. */}
      <div className="scroll">
        {view === "list" ? (
          <>
            {/* Goals — the identity layer at the very top: horizon statements
                (timeless / long / short) that give the list its "why".
                Self-contained like Notes, outside the DnD area; ⌘P → Show/Hide
                Goals toggles it completely (persisted). Goals don't take part
                in the item visibility/priority/project filters — they're a
                separate surface, shown as-is. Focus Mode hides them too: the
                lens is stricter than the default working view, and exiting
                restores whatever the toggle was. */}
            {goalsVisible && !focusMode && (
              <Goals projects={projects} onCreateProject={handleCreateProject} focusedId={focusGoalId} reloadEpoch={dataEpoch} />
            )}
            {/* Notes — the lowest-friction capture surface, right under the
                goals. Lives above the DnD area so typing/pasting isn't a drag
                surface. Self-contained: owns its state, API, and persistence.
                With Show Hidden Notes on, hidden notes render inline (dimmed)
                instead of being excluded. Notes group by priority tier like
                the Backlog (footer tokens `!N`/`#tag` — see Notes.tsx) and
                narrow under the ⌘F `#` project filter, the ⌘P note-tier
                toggles, and Focus Mode. */}
            {notesVisible && (
              <Notes
                hiddenFilter={showHiddenNotes ? "include" : "exclude"}
                focusedId={focusNoteId}
                reloadEpoch={dataEpoch}
                projects={projects}
                projectFilter={projectFilter}
                hiddenPriorities={hiddenNotePriorities}
                focusMode={focusMode}
                onCreateProject={handleCreateProject}
                onEntryRouted={handleEntryRouted}
              />
            )}
            {(hiddenPriorities.length > 0 || projectFilter !== null || agentFilter !== null) && allVisible.length === 0 && (
              <div className="empty">
                {projectFilter
                  ? `No tasks in ${projects.find((p) => p.id === projectFilter)?.name ?? "project"}.`
                  : agentFilter === "agent"
                    ? "No agent tasks."
                    : agentFilter === "mine"
                      ? "No tasks assigned to you."
                      : "No tasks at the shown priorities."}
              </div>
            )}
            <SectionList
              items={renderItems}
              visible={sectionsVisible}
              projects={projects}
              selectedId={selectedId}
              editingId={editingId}
              detailsOpenId={detailsOpenId}
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
              onToggleDetails={handleToggleDetails}
              onSetDetails={handleSetDetails}
              onMoveItem={handleMoveItem}
              onPromote={handlePromote}
              activeTimerId={activeTimer?.itemId ?? null}
              liveElapsed={liveElapsed}
              timeTotals={timeTotals}
              onToggleTimer={handleToggleTimer}
            />
          </>
        ) : view === "analytics" ? (
          <AnalyticsView />
        ) : (
          /* The written journal's own page (##j entries + the Quotes group).
             Self-contained like Notes; remounts on every view switch, so it
             always renders fresh data. */
          <Journal reloadEpoch={dataEpoch} onQuotesChanged={() => setQuotesVersion((n) => n + 1)} />
        )}
      </div>

      {/* Floating surfaces (modals/overlays) — always position:fixed, never
          inline. See AGENTS.md "Layout architecture". */}
      <SearchMenu
        open={searchOpen}
        hits={searchHits}
        projects={projects}
        activeProjectId={projectFilter}
        activeAgentFilter={agentFilter}
        onClose={() => setSearchOpen(false)}
        onJump={jumpTo}
        onSelectProject={handleSelectProject}
        onSelectAgent={handleSelectAgent}
        onRenameProject={handleRenameProject}
        onDeleteProject={handleDeleteProject}
      />
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />
      {/* The quote moment (⌘P → Show a Quote, or the idle screensaver) — a
          floating surface like the palette: dim backdrop, centered serif
          italic, never inline. App owns the open flag (the key-handler gate);
          Quotes owns pick + linger. */}
      <Quotes
        version={quotesVersion}
        open={quoteOpen}
        lingerForever={quoteIdle}
        onClose={closeQuote}
        onCount={setQuoteCount}
      />
      <KeyboardHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
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

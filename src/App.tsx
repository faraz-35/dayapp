// App — the shell. Owns app-wide state (items, selection, view), effects (load,
// sweep tick, self-update events), and global keyboard handlers (⌘P, ⌘F, j/k).
// Everything else is delegated to focused components in ./components.
//
// Layout contract (see AGENTS.md "Layout architecture"): the header is pinned
// and a single `.scroll` wrapper scrolls the whole body. Never add a second
// `overflow-y: auto` to a child — that's what caused the split-scroll bug.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, formatLiveDuration, parseProjectTag, projectsApi, timersApi, todayStr, type ActiveTimer, type HideDuration, type Item, type Project, type Section } from "./lib";
import { log } from "./log";
import Notes from "./Notes";
import SectionList from "./components/SectionList";
import JournalView from "./components/JournalView";
import HiddenView from "./components/HiddenView";
import CommandPalette, { type Command } from "./CommandPalette";
import SearchMenu, { type SearchHit } from "./components/SearchMenu";
import UpdateOverlay from "./UpdateOverlay";

type View = "list" | "journal" | "hidden";

// Self-update status, accumulated from "update-status" events emitted by the
// backend's self_update command. `lines` is the streamed build log; `message`
// is populated only on error.
export type UpdateStatus = {
  phase: "building" | "restarting" | "error";
  lines: string[];
  message: string;
};

export default function App() {
  const [items, setItems] = useState<Record<Section, Item[]>>({
    today: [],
    daily: [],
    backlog: [],
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [view, setView] = useState<View>("list");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeTimer, setActiveTimer] = useState<ActiveTimer | null>(null);
  const [timeTotals, setTimeTotals] = useState<Record<string, number>>({});
  // Wall-clock tick; bumped once a second while a timer runs, so the chip and
  // running row's elapsed update live. Idle (no re-render loop) when idle.
  const [now, setNow] = useState(() => Date.now());

  // ---- Load -------------------------------------------------------------

  const refresh = useCallback(async () => {
    const [today, daily, backlog, projs] = await Promise.all([
      api.listItems("today", false),
      api.listItems("daily", false),
      api.listItems("backlog", false),
      projectsApi.list(),
    ]);
    setItems({ today, daily, backlog });
    setProjects(projs);
  }, []);

  useEffect(() => {
    refresh().catch((e) => log.error("initial load failed", e));
    // Re-check the day boundary while the app stays open. If local time crosses
    // midnight, run the sweep so Today items fall to Backlog without a relaunch.
    const tick = setInterval(() => {
      api.runSweep().then(refresh).catch((e) => log.warn("sweep tick failed", e));
    }, 60_000);
    return () => clearInterval(tick);
  }, [refresh]);

  // The active timer persists across app restarts (its open session row is the
  // source of truth), so restore it on mount. The elapsed may be large if the
  // app was closed mid-session — that's the honest count; the chip offers a
  // discard for the "left it running overnight" case.
  useEffect(() => {
    timersApi.active().then(setActiveTimer).catch((e) => log.warn("active timer load failed", e));
  }, []);

  // All currently-visible item ids — drives the per-row cumulative totals fetch.
  const allIds = useMemo(
    () => [...items.today, ...items.daily, ...items.backlog].map((i) => i.id),
    [items],
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
  // The set of commands shown in the ⌘P palette. Navigation + the update
  // command for now; trivially extensible.
  const commands: Command[] = useMemo(() => [
    { id: "view-today", label: "Go to Today", run: () => setView("list") },
    { id: "view-journal", label: "View Journal", run: () => setView("journal") },
    { id: "view-hidden", label: "View Hidden", run: () => setView("hidden") },
    {
      id: "update",
      label: "Update DayApp",
      hint: "rebuild from source",
      run: startUpdate,
    },
  ], [startUpdate]);

  // ⌘P toggles the palette; ⌘F opens search. Both intercept globally (they're
  // modifier combos, so they don't interfere with typing in a field).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "p") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key === "f") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ---- Mutations --------------------------------------------------------

  const handleCreate = async (section: Section, raw: string) => {
    // Resolve a `#tag` → project on capture (e.g. "fix bug #day" → dayapp),
    // stripping the tag from the text. Project assignment is housekeeping, so
    // it happens after the item exists — same path as the # popover.
    const { text, projectId } = parseProjectTag(raw, projects);
    const item = await api.createItem(text, section);
    if (projectId) {
      const assigned = { ...item, projectId };
      setItems((s) => ({ ...s, [section]: [...s[section], assigned] }));
      api.setItemProject(item.id, projectId);
    } else {
      setItems((s) => ({ ...s, [section]: [...s[section], item] }));
    }
  };

  const handleComplete = async (id: string, section: Section) => {
    // Completing a running item stops its timer first — the session is kept.
    if (activeTimer?.itemId === id) {
      setActiveTimer(null);
      timersApi.stop().catch((e) => log.warn("auto-stop on complete failed", e));
    }
    if (section === "daily") {
      setItems((s) => ({
        ...s,
        daily: s.daily.map((i) =>
          i.id === id ? { ...i, lastCompletedDate: todayStr() } : i,
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
    const { text, projectId } = parseProjectTag(raw, projects);
    setEditingId(null);
    if (!text) return;
    // Apply the stripped text, and — only if a #tag resolved — override the
    // project. No tag in the edit leaves any existing assignment alone.
    setItems((s) => {
      const patch: Partial<Item> = { text };
      if (projectId) patch.projectId = projectId;
      const update = (list: Item[]) => list.map((i) => (i.id === id ? { ...i, ...patch } : i));
      return {
        today: update(s.today),
        daily: update(s.daily),
        backlog: update(s.backlog),
      };
    });
    await api.editItem(id, text);
    if (projectId) api.setItemProject(id, projectId);
  };

  // Soft-archive a task. Optimistically removed from its section; time-limited
  // hides auto-restore via the day-boundary sweep, so no timer needed here.
  const handleHide = async (id: string, section: Section, duration: HideDuration) => {
    setItems((s) => ({ ...s, [section]: s[section].filter((i) => i.id !== id) }));
    await api.hideItem(id, duration);
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

  // Optimistic reorder/move for DnD. `onMoveItem` from SectionList.
  const handleMoveItem = async (id: string, toSection: Section, newIndex: number) => {
    setItems((s) => {
      const fromSection = (["today", "daily", "backlog"] as Section[]).find(
        (sec) => s[sec].some((i) => i.id === id),
      );
      if (!fromSection) return s;
      const moved = s[fromSection].find((i) => i.id === id);
      if (!moved) return s;
      if (fromSection === toSection) {
        const list = s[fromSection].filter((i) => i.id !== id);
        list.splice(newIndex, 0, moved);
        return { ...s, [fromSection]: list };
      }
      const fromList = s[fromSection].filter((i) => i.id !== id);
      const toList = [...s[toSection]];
      toList.splice(newIndex, 0, moved);
      return { ...s, [fromSection]: fromList, [toSection]: toList };
    });
    await api.moveItem(id, toSection, newIndex);
  };

  // ---- Search -----------------------------------------------------------
  // Flattened list of all items for ⌘F. Built from live state so the SearchMenu
  // always reflects what's on screen.
  const searchHits: SearchHit[] = useMemo(
    () => ([
      ...items.today.map((item) => ({ item, section: "today" as Section })),
      ...items.daily.map((item) => ({ item, section: "daily" as Section })),
      ...items.backlog.map((item) => ({ item, section: "backlog" as Section })),
    ]),
    [items],
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

  // ---- Keyboard nav ----------------------------------------------------

  const allVisible = useMemo(
    () => [...items.today, ...items.daily, ...items.backlog],
    [items],
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
        if (item) { e.preventDefault(); handleComplete(item.id, item.section); }
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
        {view !== "list" && (
          <span className="title">{view === "journal" ? "Journal" : "Hidden"}</span>
        )}
        <div className="header-right">
          {/* The running timer is always visible here — survives scrolling away
              from the timed row, and doubles as a "current focus" display. Click
              the body to stop (keep the session); × discards it entirely. */}
          {activeTimer && (
            <div className="timer-chip" title="Timer running">
              <button
                className="timer-chip-main"
                onClick={() => handleToggleTimer(activeTimer.itemId)}
                title="Stop timer (keep session)"
              >
                <span className="timer-chip-pulse" />
                <span className="timer-chip-name">{activeTimer.itemText || "Timer"}</span>
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
          {view === "list" && (
            <button
              className={`icon-btn search-btn${searchOpen ? " active" : ""}`}
              onClick={() => setSearchOpen(true)}
              title="Search (⌘F)"
              aria-label="Search"
            >⌕</button>
          )}
          <button
            className={`icon-btn ${view === "hidden" ? "active" : ""}`}
            onClick={() => setView(view === "hidden" ? "list" : "hidden")}
            title={view === "hidden" ? "Back to list" : "View hidden"}
            aria-label="Toggle hidden"
          >
            {view === "hidden" ? "✕" : "◐"}
          </button>
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
          journal/hidden view) scrolls as one page. See AGENTS.md. */}
      <div className="scroll">
        {view === "list" ? (
          <>
            {/* Notes live above the DnD area so typing/pasting isn't a drag
                surface. Self-contained: owns its state, API, and persistence. */}
            <Notes />
            <SectionList
              items={items}
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
              onSetProject={handleSetProject}
              onSetReminder={handleSetReminder}
              onMoveItem={handleMoveItem}
              activeTimerId={activeTimer?.itemId ?? null}
              liveElapsed={liveElapsed}
              timeTotals={timeTotals}
              onToggleTimer={handleToggleTimer}
            />
          </>
        ) : view === "journal" ? (
          <JournalView />
        ) : (
          <HiddenView />
        )}
      </div>

      {/* Floating surfaces (modals/overlays) — always position:fixed, never
          inline. See AGENTS.md "Layout architecture". */}
      <SearchMenu
        open={searchOpen}
        hits={searchHits}
        onClose={() => setSearchOpen(false)}
        onJump={jumpTo}
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
    </div>
  );
}

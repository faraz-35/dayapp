// Header — the app's pinned top bar: the rotating masthead, the running-timer
// chip, and the right icon cluster (palette door, ◐ archive peek, the view
// doors, theme cycle, release-update). Extracted from App verbatim; App owns
// every state the header renders and passes it in. The bar is the window's
// drag region — data-tauri-drag-region on the bar, nothing on the buttons.

import { log } from "../logging/log";
import { trace } from "../logging/devlog";
import { demoApi } from "../api/system";
import { formatLiveDuration } from "../lib/format";
import { isMac } from "../lib/platform";
import type { ActiveTimer } from "../types/timer";
import {
  IconAnalytics,
  IconClose,
  IconCommandPalette,
  IconJournal,
  IconMoon,
  IconQuotes,
  IconSettings,
  IconSun,
  IconUpdate,
  IconX,
} from "./icons";

export type View = "list" | "analytics" | "journal" | "quotes" | "settings";

// One view door in the cluster: active reads the close X and returns to the
// list; inactive reads its glyph and opens the view. The four doors share
// this shape exactly.
function ViewDoor({
  name, active, icon, onSwitch,
}: {
  name: Exclude<View, "list">;
  active: boolean;
  icon: React.ReactNode;
  onSwitch: (v: View) => void;
}) {
  return (
    <button
      className={`icon-btn ${active ? "active" : ""}`}
      onClick={() => {
        const next = active ? "list" : name;
        trace("view.switch", { view: next });
        onSwitch(next);
      }}
      title={active ? "Back to list" : labelFor(name)}
      aria-label={`Toggle ${name}`}
    >
      {active ? <IconClose /> : icon}
    </button>
  );
}

// The door tooltips, verbatim from the four buttons this component folded.
const labelFor = (v: View): string =>
  v === "analytics" ? "View analytics"
  : v === "journal" ? "View journal"
  : v === "quotes" ? "View quotes"
  : "Open settings";

export default function Header({
  view, onSwitchView,
  liveAt, demoMode,
  activeTimer, liveElapsed, onStopTimer, onDiscardTimer,
  headerBtns,
  onOpenPalette,
  archiveShown, archiveAnyAxis, onToggleArchive,
  journalEnabled, quotesEnabled,
  themeName, themeLight, themeSlotIndex, themeSlotCount, onCycleTheme,
  releaseUpdate, onStartReleaseUpdate,
}: {
  view: View;
  onSwitchView: (v: View) => void;
  liveAt: string;
  demoMode: boolean;
  activeTimer: ActiveTimer | null;
  liveElapsed: number;
  onStopTimer: (itemId: string) => void;
  onDiscardTimer: () => void;
  headerBtns: Record<string, boolean>;
  onOpenPalette: () => void;
  /** The ◐'s state + fan-out toggle, over only the archive axes that exist. */
  archiveShown: boolean;
  archiveAnyAxis: boolean;
  onToggleArchive: (next: boolean) => void;
  journalEnabled: boolean;
  quotesEnabled: boolean;
  themeName: string;
  themeLight: boolean;
  themeSlotIndex: number;
  themeSlotCount: number;
  onCycleTheme: () => void;
  releaseUpdate: string | null;
  onStartReleaseUpdate: () => void;
}) {
  return (
    <header className="header" data-tauri-drag-region>
      {/* The list view carries the brand — "Live @ Faraz" is home, and every
          2 minutes it steps out to a random MASTHEAD_THEMES word and back
          (keyed so each swap fades in; see title-in in styles/header.css). The
          analytics view carries its own title. Always rendered — the timer
          chip carries no task-name text (tooltip only), so the two coexist
          on the 480px window. Below ~455px the media query hides the masthead.

          Demo mode outranks both: the masthead reads "Live @ Demo" in every
          view while the disposable demo db is active — the one unmissable
          (but calm) signal of which data is on screen. */}
      <span className="title" data-tauri-drag-region key={demoMode ? "demo" : view === "list" ? liveAt : view}>
        {demoMode ? "Live @ Demo" : view === "analytics" ? "Analytics" : view === "journal" ? "Journal" : view === "quotes" ? "Quotes" : view === "settings" ? "Settings" : `Live @ ${liveAt}`}
      </span>
      <div className="header-right">
        {/* Demo mode's standing exit — the labeled door beside the ⌘P
            entry, first in the cluster so it sits left of the icon
            buttons. It IS the first-run tour's on-ramp (a brand-new
            install launches straight into the demo), so it reads as text,
            not an icon. The demo.enter/exit trace rides the demoMode
            transition effect in App; the click only fires the swap. */}
        {demoMode && (
          <button
            className="demo-exit"
            onClick={() => demoApi.exit().catch((e) => log.error("demo exit failed", e))}
            title="Leave the sample data — back to your real list"
          >
            Exit Demo
          </button>
        )}
        {/* The running timer is always visible here — survives scrolling away
            from the timed row, and doubles as a "current focus" display.
            Pulse + elapsed only; the task name rides in the tooltip so the
            centered masthead never has to hide. Click to stop (keep the
            session); × discards it entirely. */}
        {activeTimer && (
          <div className="timer-chip" title="Timer running">
            <button
              className="timer-chip-main"
              onClick={() => onStopTimer(activeTimer.itemId)}
              title={`Stop timer (keep session) — ${activeTimer.itemText || "Timer"}`}
            >
              <span className="timer-chip-pulse" />
              <span className="timer-chip-elapsed">{formatLiveDuration(liveElapsed)}</span>
            </button>
            <button
              className="timer-chip-discard"
              onClick={onDiscardTimer}
              title="Discard session (don't save)"
              aria-label="Discard timer"
            ><IconX /></button>
          </div>
        )}
        {/* The command palette's mouse door — opens what ⌘P opens. First in
            the icon cluster: the palette is the primary door, and this is the
            way in for people who never learn the chord. The glyph
            mirrors the platform's real modifier: ⌘ on macOS, the prompt
            field where Ctrl rules (no Ctrl pictograph exists to draw). */}
        {headerBtns.palette && (
          <button
            className="icon-btn"
            onClick={onOpenPalette}
            title={isMac ? "Open command palette (⌘P)" : "Open command palette (Ctrl+P)"}
            aria-label="Open command palette"
          >
            <IconCommandPalette />
          </button>
        )}
        {/* ◐ toggles the hidden surfaces that exist (each archive axis has
            its Settings switch — a switched-off axis never flips): all
            enabled surfaces together. Settings → Header picks whether the
            button mounts at all. */}
        {headerBtns.hidden && archiveAnyAxis && (
          <button
            className={`icon-btn ${archiveShown ? "active" : ""}`}
            onClick={() => {
              trace("toggle.hidden", { show: !archiveShown });
              onToggleArchive(!archiveShown);
            }}
            title={archiveShown ? "Hide hidden entries" : "Show hidden entries inline"}
            aria-label="Toggle hidden entries"
          >
            {/* The ◐ mark, drawn at the set's size — the text glyph rode
                the font's metrics and rendered oversized. */}
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <circle cx="8" cy="8" r="5.9" fill="none" stroke="currentColor" strokeWidth="1.7" />
              <path d="M8 2.1a5.9 5.9 0 0 1 0 11.8Z" fill="currentColor" stroke="none" />
            </svg>
          </button>
        )}
        {headerBtns.analytics && (
          <ViewDoor name="analytics" active={view === "analytics"} icon={<IconAnalytics />} onSwitch={onSwitchView} />
        )}
        {/* The Journal view's door (the written word; Analytics keeps the
            numbers) and the Quotes view's door (the ##q pool, browsed and
            edited; the modal keeps the summoned moment) — same per-button
            toggle as the analytics door, each gated on its feature. */}
        {journalEnabled && headerBtns.journal && (
          <ViewDoor name="journal" active={view === "journal"} icon={<IconJournal />} onSwitch={onSwitchView} />
        )}
        {quotesEnabled && headerBtns.quotes && (
          <ViewDoor name="quotes" active={view === "quotes"} icon={<IconQuotes />} onSwitch={onSwitchView} />
        )}
        {/* The theme cycle — one click to the next theme in the ladder. The
            glyph is the active theme's mode: night the moon, day the sun,
            subscripted by the slot within the mode while the mode has more
            than one theme. */}
        {headerBtns.theme && (
          <button
            className="icon-btn theme-cycle"
            onClick={onCycleTheme}
            title={`Theme: ${themeName}`}
            aria-label="Cycle theme"
          >
            {themeLight ? <IconSun /> : <IconMoon />}
            {themeSlotCount > 1 && (
              <span className="theme-idx" aria-hidden="true">{themeSlotIndex}</span>
            )}
          </button>
        )}
        {/* The Settings door (the gear) — same per-button toggle as the
            other view doors. */}
        {headerBtns.settings && (
          <ViewDoor name="settings" active={view === "settings"} icon={<IconSettings />} onSwitch={onSwitchView} />
        )}
        {/* The release-update door (release installs only — source
            checkouts use ⌘P → Update App Locally instead): mounts only
            while a newer release exists on the channel; one click
            downloads, signature-verifies, and swaps the app in place.
            Hidden in demo mode — a relaunch would end the demo session
            (and a first-run tour has no update to take anyway). */}
        {releaseUpdate && !demoMode && (
          <button
            className="icon-btn update-ready"
            onClick={onStartReleaseUpdate}
            title={`Update available: v${releaseUpdate} — download & install`}
            aria-label="Install available update"
          >
            <IconUpdate />
          </button>
        )}
      </div>
    </header>
  );
}

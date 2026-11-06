// SettingsView — the settings page shell (⌘P → Settings): a tab bar under
// the header picking one of four panes (2026-10-16, the settings-look tabs
// mockup), reset to Features on every open — the page remounts per view
// switch, like Analytics. The panes live beside this file: FeaturesPane
// (the Tasks / Notes / Goals surface cards), AppearancePane (the theme
// ladder + the Look rows), HeaderPane (which icon buttons mount), ViewsPane
// (the lenses + their builder). Row primitives and the vocabulary they share
// are rows.tsx / vocab.ts.
//
// Rows are dependency-aware: a feature that's off sends its dependents inert
// with a hint saying why — every sub-row needs its card's master (daily pause
// the tighter Daily), the Header rows need their features (the Hidden button
// needs any archive axis), the screensaver needs Quotes. The same gates App
// applies when rendering, now visible at the control itself.
//
// Mouse-first like Analytics: no focus-grammar wiring (free-mode j/k
// scrolling works globally, Esc closes the page).

import { useState } from "react";
import { trace } from "../../logging/devlog";
import type { Theme } from "../../themes";
import type { Project } from "../../types/project";
import { TABS, type FeatureKey, type HeaderBtn, type Tab } from "./vocab";
import FeaturesPane from "./FeaturesPane";
import AppearancePane from "./AppearancePane";
import HeaderPane from "./HeaderPane";
import ViewsPane from "./ViewsPane";
import type { CustomView } from "../../lib/views";

export default function SettingsView({
  features, onToggleFeature, projects,
  views, activeViewId, viewsEnabled, onToggleViewsEnabled,
  onToggleViewActive, onCreateView, onUpdateView, onDeleteView,
  notesCard, tasksCard, onSetCard, screensaverMins, onSetScreensaverMins,
  headerBtns, onToggleHeaderBtn, backlogBars, noteBars, onSetPriorityBars,
  projectColorsSingle, onSetProjectColors, windowDecorations,
  onToggleWindowDecorations, themeId, customThemes, onActivateTheme,
  onCreateTheme, onDeleteTheme,
}: {
  features: Record<FeatureKey, boolean>;
  onToggleFeature: (key: FeatureKey) => void;
  projects: Project[];
  views: CustomView[];
  activeViewId: string | null;
  viewsEnabled: boolean;
  onToggleViewsEnabled: (on: boolean) => void;
  onToggleViewActive: (id: string) => void;
  onCreateView: (view: CustomView) => void;
  onUpdateView: (id: string, view: CustomView) => void;
  onDeleteView: (id: string) => void;
  notesCard: boolean;
  tasksCard: boolean;
  onSetCard: (surface: "notes" | "tasks", card: boolean) => void;
  backlogBars: boolean;
  noteBars: boolean;
  onSetPriorityBars: (surface: "backlog" | "notes", bars: boolean) => void;
  projectColorsSingle: boolean;
  onSetProjectColors: (single: boolean) => void;
  screensaverMins: number;
  onSetScreensaverMins: (mins: number) => void;
  headerBtns: Record<HeaderBtn, boolean>;
  onToggleHeaderBtn: (btn: HeaderBtn) => void;
  windowDecorations: boolean;
  onToggleWindowDecorations: (on: boolean) => void;
  themeId: string;
  customThemes: Theme[];
  onActivateTheme: (id: string) => void;
  onCreateTheme: (theme: Theme) => void;
  onDeleteTheme: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("features");

  return (
    <div className="settings">
      {/* One pane at a time; the bar is sticky in the one .scroll, so it pins
          under the header only while a pane actually scrolls. */}
      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? "on" : ""}
            onClick={() => { trace("ui.settingsTab", { tab: t.id }); setTab(t.id); }}
          >{t.label}</button>
        ))}
      </div>
      {tab === "features" && (
        <FeaturesPane
          features={features}
          onToggleFeature={onToggleFeature}
          screensaverMins={screensaverMins}
          onSetScreensaverMins={onSetScreensaverMins}
        />
      )}
      {tab === "appearance" && (
        <AppearancePane
          features={features}
          themeId={themeId}
          customThemes={customThemes}
          onActivateTheme={onActivateTheme}
          onCreateTheme={onCreateTheme}
          onDeleteTheme={onDeleteTheme}
          notesCard={notesCard}
          tasksCard={tasksCard}
          onSetCard={onSetCard}
          backlogBars={backlogBars}
          noteBars={noteBars}
          onSetPriorityBars={onSetPriorityBars}
          projectColorsSingle={projectColorsSingle}
          onSetProjectColors={onSetProjectColors}
        />
      )}
      {tab === "header" && (
        <HeaderPane
          features={features}
          headerBtns={headerBtns}
          onToggleHeaderBtn={onToggleHeaderBtn}
          windowDecorations={windowDecorations}
          onToggleWindowDecorations={onToggleWindowDecorations}
        />
      )}
      {tab === "views" && (
        <ViewsPane
          features={features}
          projects={projects}
          views={views}
          activeViewId={activeViewId}
          viewsEnabled={viewsEnabled}
          onToggleViewsEnabled={onToggleViewsEnabled}
          onToggleViewActive={onToggleViewActive}
          onCreateView={onCreateView}
          onUpdateView={onUpdateView}
          onDeleteView={onDeleteView}
        />
      )}
    </div>
  );
}

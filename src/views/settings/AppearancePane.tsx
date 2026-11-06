// AppearancePane — two cards. Theme on top: the ladder (System first, then
// the eleven-shade cards in editor order, so a theme reads at a glance) with
// its create form. Look beneath: the resting fills, how the two grouped
// surfaces show priority tiers, whether projects carry their own hue. The
// priority rows go inert while their surface's priority axis is off (no
// tiers can exist), the colors row while every projects axis is off (no
// labels render).

import { useState } from "react";
import { clip, trace } from "../../logging/devlog";
import { BUILT_IN_THEMES, COLOR_FIELDS, DARK, LIGHT, applyTheme, systemTheme, type Theme, type ThemeColors } from "../../themes";
import { IconX } from "../../components/icons";
import type { FeatureKey } from "./vocab";
import { Group, InfoRow, Seg } from "./rows";

export default function AppearancePane({
  features,
  themeId, customThemes, onActivateTheme, onCreateTheme, onDeleteTheme,
  notesCard, tasksCard, onSetCard,
  backlogBars, noteBars, onSetPriorityBars,
  projectColorsSingle, onSetProjectColors,
}: {
  features: Record<FeatureKey, boolean>;
  themeId: string;
  customThemes: Theme[];
  onActivateTheme: (id: string) => void;
  onCreateTheme: (theme: Theme) => void;
  onDeleteTheme: (id: string) => void;
  notesCard: boolean;
  tasksCard: boolean;
  onSetCard: (surface: "notes" | "tasks", card: boolean) => void;
  /** How the two grouped surfaces show priority tiers: dividers (the
   *  default) or bars on each row/card. */
  backlogBars: boolean;
  noteBars: boolean;
  onSetPriorityBars: (surface: "backlog" | "notes", bars: boolean) => void;
  /** Project colors: a hue per project (false) or one grey for all. */
  projectColorsSingle: boolean;
  onSetProjectColors: (single: boolean) => void;
}) {
  // The theme draft (New Theme form): eleven shades, applied live to the
  // document as they're tweaked — Cancel re-applies the active theme.
  const [draft, setDraft] = useState<{ name: string; colors: ThemeColors } | null>(null);

  const cancelTheme = () => {
    setDraft(null);
    // Re-apply the active theme directly — setThemeId(same id) wouldn't re-run
    // App's apply effect, and the preview would stick.
    applyTheme(themeId === "system"
      ? systemTheme()
      : [...BUILT_IN_THEMES, ...customThemes].find((t) => t.id === themeId) ?? BUILT_IN_THEMES[0]);
  };
  const createThemeNow = () => {
    if (!draft || !draft.name.trim()) return;
    trace("theme.create", { name: clip(draft.name) });
    onCreateTheme({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      name: draft.name.trim(),
      colors: draft.colors,
    });
    setDraft(null); // onCreateTheme activates the new theme — the preview sticks
  };

  return (
    <>
      <Group title="Theme">
        <div className="set-theme-grid">
        {/* System — the factory default: follow the OS light/dark, live. The
            strip wears both ladders (dark's shades left, light's right). */}
        <div
          role="button"
          className={`set-theme-card${themeId === "system" ? " on" : ""}`}
          title="Follow the OS light/dark"
          onClick={() => { trace("theme.activate", { id: "system" }); onActivateTheme("system"); }}
        >
          <span className="set-strip">
            {COLOR_FIELDS.map(({ key }, i) => (
              <i key={key} style={{ background: i < 6 ? DARK.colors[key] : LIGHT.colors[key] }} />
            ))}
          </span>
          <span className="set-theme-foot">
            <span className="set-theme-name">System</span>
            {themeId === "system" && <span className="set-state on">Active</span>}
          </span>
        </div>
        {[...BUILT_IN_THEMES, ...customThemes].map((t) => {
          const active = themeId === t.id;
          const builtIn = BUILT_IN_THEMES.some((b) => b.id === t.id);
          return (
            <div
              key={t.id}
              role="button"
              className={`set-theme-card${active ? " on" : ""}`}
              onClick={() => { trace("theme.activate", { id: t.id }); onActivateTheme(t.id); }}
            >
              <span className="set-strip">
                {COLOR_FIELDS.map(({ key }) => (
                  <i key={key} style={{ background: t.colors[key] }} />
                ))}
              </span>
              <span className="set-theme-foot">
                <span className="set-theme-name">{t.name}</span>
                {active && <span className="set-state on">Active</span>}
                {!builtIn && (
                  <button
                    className="set-x"
                    title="Delete theme"
                    aria-label={`Delete ${t.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      trace("theme.delete", { id: t.id });
                      onDeleteTheme(t.id);
                    }}
                  ><IconX /></button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      {!draft && (
        <button
          className="set-new"
          title="Eleven shades, previewed live"
          onClick={() => {
            const base = [...BUILT_IN_THEMES, ...customThemes].find((t) => t.id === themeId);
            setDraft({ name: "", colors: { ...(base ?? BUILT_IN_THEMES[0]).colors } });
          }}
        >
          <b>+</b> New theme
        </button>
      )}
      {draft && (
        <div className="settings-form">
          <input
            className="settings-name-input"
            placeholder="Theme name"
            value={draft.name}
            autoFocus
            spellCheck={false}
            onChange={(e) => {
              if (!draft) return;
              setDraft({ ...draft, name: e.target.value });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); createThemeNow(); }
              else if (e.key === "Escape") { e.preventDefault(); cancelTheme(); }
            }}
          />
          <div className="settings-colors">
            {COLOR_FIELDS.map(({ key, label }) => (
              <label className="settings-color" key={key}>
                <span>{label}</span>
                <input
                  type="color"
                  value={draft.colors[key]}
                  onChange={(e) => {
                    if (!draft) return;
                    const colors = { ...draft.colors, [key]: e.target.value };
                    setDraft({ ...draft, colors });
                    // Live preview: the draft skins the app as you tweak;
                    // Cancel re-applies the active theme.
                    applyTheme({ id: "draft", name: draft.name || "Draft", colors });
                  }}
                />
              </label>
            ))}
          </div>
          <div className="settings-form-actions">
            <button className="pill" onClick={cancelTheme}>Cancel</button>
            <button className="settings-save" disabled={!draft.name.trim()} onClick={createThemeNow}>Create Theme</button>
          </div>
        </div>
      )}
      </Group>
      <Group title="Look">
        <div className="set-rows">
          <InfoRow label="Notes background" hint="the fill behind each note">
            <Seg
              value={notesCard ? "card" : "bare"}
              options={[{ v: "card", label: "Card" }, { v: "bare", label: "Bare" }]}
              onPick={(v) => { trace("ui.card", { surface: "notes", to: v === "card" }); onSetCard("notes", v === "card"); }}
            />
          </InfoRow>
          <InfoRow label="Tasks background" hint="the fill behind each row">
            <Seg
              value={tasksCard ? "card" : "bare"}
              options={[{ v: "card", label: "Card" }, { v: "bare", label: "Bare" }]}
              onPick={(v) => { trace("ui.card", { surface: "tasks", to: v === "card" }); onSetCard("tasks", v === "card"); }}
            />
          </InfoRow>
          <InfoRow
            label="Backlog priorities"
            hint="tier dividers between the groups, or bars on each row — Today's look"
            needs={!features.taskPriorities}
            needsLabel="Task priorities"
          >
            <Seg
              value={backlogBars ? "bars" : "dividers"}
              options={[{ v: "dividers", label: "Dividers" }, { v: "bars", label: "Bars" }]}
              onPick={(v) => { trace("ui.priority-bars", { surface: "backlog", to: v }); onSetPriorityBars("backlog", v === "bars"); }}
            />
          </InfoRow>
          <InfoRow
            label="Note priorities"
            hint="tier dividers between the groups, or bars on each card"
            needs={!features.notePriorities}
            needsLabel="Note priorities"
          >
            <Seg
              value={noteBars ? "bars" : "dividers"}
              options={[{ v: "dividers", label: "Dividers" }, { v: "bars", label: "Bars" }]}
              onPick={(v) => { trace("ui.priority-bars", { surface: "notes", to: v }); onSetPriorityBars("notes", v === "bars"); }}
            />
          </InfoRow>
          <InfoRow
            label="Project colors"
            hint="a hue per project, or one grey for every label"
            needs={!features.taskProjects && !features.noteProjects && !features.goalProjects}
            needsLabel="a projects switch"
          >
            <Seg
              value={projectColorsSingle ? "single" : "multi"}
              options={[{ v: "multi", label: "Multi" }, { v: "single", label: "Single" }]}
              onPick={(v) => { trace("ui.project-colors", { to: v }); onSetProjectColors(v === "single"); }}
            />
          </InfoRow>
        </div>
      </Group>
    </>
  );
}

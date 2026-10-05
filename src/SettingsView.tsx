// SettingsView — the settings page (⌘P → Settings). Two groups over the
// analytics card language:
//
// Features — what exists at all: Tasks (the capture + all three sections),
// the Today/Daily/Backlog sections inside it, Notes, Goals. The same six
// persisted toggles that used to be ⌘P Show/Hide entries, collected on one
// page (2026-10-04 — the palette entries retired into it).
//
// Views — custom lenses like Focus/Fun Mode: a named combination of the
// display axes (priority tiers, the delegation axis, project, notes and
// their tiers). Activating one narrows the working view through the same
// pipelines the toggles and ⌘F filters use; exiting restores everything —
// a lens, never a mutation. Views persist in localStorage (dayapp-views,
// the active one dayapp-active-view) like every display preference.
//
// Mouse-first like Analytics: no focus-grammar wiring (free-mode j/k
// scrolling works globally).

import { useState } from "react";
import { type Project } from "./lib";
import { clip, trace } from "./devlog";
import { BUILT_IN_THEMES, COLOR_FIELDS, applyTheme, type Theme, type ThemeColors } from "./themes";

export type FeatureKey =
  | "tasks" | "today" | "daily" | "backlog" | "notes" | "goals" | "journal" | "quotes"
  | "projects" | "taskPriorities" | "notePriorities" | "agent" | "timer" | "reminders" | "hide";

// The header's icon buttons — each an On/Off choice in the Header group.
export type HeaderBtn = "hidden" | "analytics" | "journal" | "quotes" | "settings";

const HEADER_BUTTONS: { key: HeaderBtn; label: string; hint: string }[] = [
  { key: "hidden", label: "Hidden entries", hint: "the ◐ archive peek" },
  { key: "analytics", label: "Analytics", hint: "the chart icon" },
  { key: "journal", label: "Journal", hint: "the prose icon" },
  { key: "quotes", label: "Quotes", hint: "the quote icon" },
  { key: "settings", label: "Settings", hint: "the gear icon" },
];

export interface CustomView {
  id: string;
  name: string;
  // The tiers the lens keeps; a missing tier is hidden while the view is
  // active. Unmarked rows are never touched (the ⌘P tier rule).
  priorities: (1 | 2 | 3)[];
  // The delegation axis: all | agent (🤖 rows only) | mine.
  agent: "all" | "agent" | "mine";
  projectId: string | null;
  notes: boolean;
  notePriorities: (1 | 2 | 3)[];
}

const ALL_TIERS = [1, 2, 3] as const;

// One line on what a view shows — the row hint here and the ⌘P entry hint.
// "everything" when no axis is narrowed.
export const viewSummary = (v: CustomView, projects: Project[]): string => {
  const parts: string[] = [];
  if (v.priorities.length < 3) {
    parts.push(v.priorities.length === 0
      ? "no priorities"
      : [...v.priorities].sort().map((p) => `P${p}`).join("+"));
  }
  if (v.agent !== "all") parts.push(v.agent === "agent" ? "agent" : "mine");
  if (v.projectId) parts.push(`#${projects.find((p) => p.id === v.projectId)?.name ?? "project"}`);
  if (!v.notes) parts.push("no notes");
  else if (v.notePriorities.length < 3) {
    parts.push(v.notePriorities.length === 0
      ? "no note tiers"
      : `notes ${[...v.notePriorities].sort().map((p) => `P${p}`).join("+")}`);
  }
  return parts.join(" · ");
};

const FEATURES: { key: FeatureKey; label: string; hint: string }[] = [
  { key: "tasks", label: "Tasks", hint: "capture + all three sections" },
  { key: "today", label: "Today", hint: "section" },
  { key: "daily", label: "Daily", hint: "section" },
  { key: "backlog", label: "Backlog", hint: "section" },
  { key: "notes", label: "Notes", hint: "the notepad surface" },
  { key: "goals", label: "Goals", hint: "the identity layer" },
  { key: "journal", label: "Journal", hint: "##j entries + the page" },
  { key: "quotes", label: "Quotes", hint: "##q entries, the page + the idle moment" },
  { key: "projects", label: "Projects", hint: "the #tag axis for tasks, notes, goals" },
  { key: "taskPriorities", label: "Task priorities", hint: "the !1–!3 tiers + signal bars" },
  { key: "notePriorities", label: "Note priorities", hint: "the !N footer tiers on notes" },
  { key: "agent", label: "Agent delegation", hint: "the @ axis — 🤖 badge + the agent queue" },
  { key: "timer", label: "Timer", hint: "per-task time tracking (▶ / ⏱)" },
  { key: "reminders", label: "Reminders", hint: "the ◷ date that pulls a row to Today" },
  { key: "hide", label: "Hide", hint: "soft-archive rows and notes (◐)" },
];

export default function SettingsView({
  features, onToggleFeature, projects, views, activeViewId,
  onToggleViewActive, onCreateView, onDeleteView,
  notesCard, tasksCard, onSetCard, headerBtns, onToggleHeaderBtn,
  themeId, customThemes, onActivateTheme, onCreateTheme, onDeleteTheme,
}: {
  features: Record<FeatureKey, boolean>;
  onToggleFeature: (key: FeatureKey) => void;
  projects: Project[];
  views: CustomView[];
  activeViewId: string | null;
  onToggleViewActive: (id: string) => void;
  onCreateView: (view: CustomView) => void;
  onDeleteView: (id: string) => void;
  notesCard: boolean;
  tasksCard: boolean;
  onSetCard: (surface: "notes" | "tasks", card: boolean) => void;
  headerBtns: Record<HeaderBtn, boolean>;
  onToggleHeaderBtn: (btn: HeaderBtn) => void;
  themeId: string;
  customThemes: Theme[];
  onActivateTheme: (id: string) => void;
  onCreateTheme: (theme: Theme) => void;
  onDeleteTheme: (id: string) => void;
}) {
  // Two independent create-forms — one state for both made "+ New Theme"
  // open the Views form too (2026-10-05). The theme form's gate is its draft
  // (null = closed), so only the Views form needs a boolean.
  const [creatingView, setCreatingView] = useState(false);
  const [name, setName] = useState("");
  const [priorities, setPriorities] = useState<(1 | 2 | 3)[]>([1, 2, 3]);
  const [agent, setAgent] = useState<CustomView["agent"]>("all");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [notes, setNotes] = useState(true);
  const [notePriorities, setNotePriorities] = useState<(1 | 2 | 3)[]>([1, 2, 3]);
  // The theme draft (New Theme form): eleven shades, applied live to the
  // document as they're tweaked — Cancel re-applies the active theme.
  const [draft, setDraft] = useState<{ name: string; colors: ThemeColors } | null>(null);

  const cancelTheme = () => {
    setDraft(null);
    // Re-apply the active theme directly — setThemeId(same id) wouldn't re-run
    // App's apply effect, and the preview would stick.
    applyTheme([...BUILT_IN_THEMES, ...customThemes].find((t) => t.id === themeId) ?? BUILT_IN_THEMES[0]);
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

  const resetDraft = () => {
    setName("");
    setPriorities([1, 2, 3]);
    setAgent("all");
    setProjectId(null);
    setNotes(true);
    setNotePriorities([1, 2, 3]);
  };

  const create = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    trace("views.create", { name: clip(trimmed) });
    onCreateView({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      name: trimmed,
      priorities: [...priorities],
      agent,
      projectId,
      notes,
      notePriorities: [...notePriorities],
    });
    resetDraft();
    setCreatingView(false);
  };

  const toggleTier = (
    n: 1 | 2 | 3,
    list: (1 | 2 | 3)[],
    set: (v: (1 | 2 | 3)[]) => void,
  ) => set(list.includes(n) ? list.filter((p) => p !== n) : [...list, n]);

  return (
    <div className="settings">
      <div className="an-card">
        <div className="an-card-title">
          Features
          <span className="hint">what exists at all — show/hide stays in ⌘P</span>
        </div>
        <div className="settings-rows">
          {FEATURES.map(({ key, label, hint }) => (
            <div className="settings-row" key={key}>
              <button
                className="settings-main"
                onClick={() => {
                  trace("toggle.feature", { feature: key, to: !features[key] });
                  onToggleFeature(key);
                }}
              >
                <span className="settings-name">{label}</span>
                <span className="settings-hint">{hint}</span>
              </button>
              <span className={`settings-state${features[key] ? " on" : ""}`}>
                {features[key] ? "On" : "Off"}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="an-card">
        <div className="an-card-title">
          UI
          <span className="hint">the resting fill behind notes and task rows</span>
        </div>
        <div className="settings-rows">
          {([["notes", "Notes background", "the soft card behind each note"],
             ["tasks", "Tasks background", "the soft card behind each row"]] as const).map(
            ([key, label, hint]) => {
              const card = key === "notes" ? notesCard : tasksCard;
              return (
                <div className="settings-row" key={key}>
                  <div className="settings-main">
                    <span className="settings-name">{label}</span>
                    <span className="settings-hint">{hint}</span>
                  </div>
                  <button
                    className={`pill${card ? " active" : ""}`}
                    onClick={() => { trace("ui.card", { surface: key, to: true }); onSetCard(key, true); }}
                  >Card</button>
                  <button
                    className={`pill${!card ? " active" : ""}`}
                    onClick={() => { trace("ui.card", { surface: key, to: false }); onSetCard(key, false); }}
                  >Bare</button>
                </div>
              );
            },
          )}
        </div>
      </div>

      <div className="an-card">
        <div className="an-card-title">
          Header
          <span className="hint">icon buttons top-right — the views stay in ⌘P</span>
        </div>
        <div className="settings-rows">
          {HEADER_BUTTONS.map(({ key, label, hint }) => (
            <div className="settings-row" key={key}>
              <button
                className="settings-main"
                onClick={() => {
                  trace("toggle.header", { btn: key, to: !headerBtns[key] });
                  onToggleHeaderBtn(key);
                }}
              >
                <span className="settings-name">{label}</span>
                <span className="settings-hint">{hint}</span>
              </button>
              <span className={`settings-state${headerBtns[key] ? " on" : ""}`}>
                {headerBtns[key] ? "On" : "Off"}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="an-card">
        <div className="an-card-title">
          Appearance
          <span className="hint">the color ladder — Dark, Light, or your own</span>
        </div>
        <div className="settings-rows">
          {[...BUILT_IN_THEMES, ...customThemes].map((t) => {
            const active = themeId === t.id;
            const builtIn = BUILT_IN_THEMES.some((b) => b.id === t.id);
            return (
              <div className="settings-row" key={t.id}>
                <button
                  className="settings-main"
                  onClick={() => {
                    trace("theme.activate", { id: t.id });
                    onActivateTheme(t.id);
                  }}
                >
                  <span className="settings-name">{t.name}</span>
                  <span className="settings-theme-dots">
                    {[t.colors.bg, t.colors.bgElev, t.colors.accent, t.colors.text].map((c, i) => (
                      <i key={i} style={{ background: c }} />
                    ))}
                  </span>
                </button>
                {active && <span className="settings-state on">Active</span>}
                {!builtIn && (
                  <button
                    className="settings-x"
                    title="Delete theme"
                    aria-label={`Delete ${t.name}`}
                    onClick={() => {
                      trace("theme.delete", { id: t.id });
                      onDeleteTheme(t.id);
                    }}
                  >×</button>
                )}
              </div>
            );
          })}
          {!draft && (
            <div className="settings-row">
              <button
                className="settings-main"
                onClick={() => {
                  const base = [...BUILT_IN_THEMES, ...customThemes].find((t) => t.id === themeId);
                  setDraft({ name: "", colors: { ...(base ?? BUILT_IN_THEMES[0]).colors } });
                }}
              >
                <span className="settings-name">+ New Theme</span>
                <span className="settings-hint">eleven shades, previewed live</span>
              </button>
            </div>
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
        </div>
      </div>

      <div className="an-card">
        <div className="an-card-title">
          Views
          <span className="hint">lenses like focus mode — click to enter, click again to exit</span>
        </div>
        <div className="settings-rows">
          {views.map((v) => {
            const active = activeViewId === v.id;
            return (
              <div className="settings-row" key={v.id}>
                <button
                  className="settings-main"
                  onClick={() => {
                    trace("views.activate", { name: clip(v.name), to: !active });
                    onToggleViewActive(v.id);
                  }}
                >
                  <span className="settings-name">{v.name}</span>
                  <span className="settings-hint">{viewSummary(v, projects)}</span>
                </button>
                {active && <span className="settings-state on">Active</span>}
                <button
                  className="settings-x"
                  title="Delete view"
                  aria-label={`Delete ${v.name}`}
                  onClick={() => {
                    trace("views.delete", { name: clip(v.name) });
                    onDeleteView(v.id);
                  }}
                >×</button>
              </div>
            );
          })}
          {!creatingView && (
            <div className="settings-row">
              <button className="settings-main" onClick={() => setCreatingView(true)}>
                <span className="settings-name">+ New View</span>
                <span className="settings-hint">combine priorities, agent, project, notes</span>
              </button>
            </div>
          )}
          {creatingView && (
            <div className="settings-form">
              <input
                className="settings-name-input"
                placeholder="View name"
                value={name}
                autoFocus
                spellCheck={false}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); create(); }
                  else if (e.key === "Escape") { e.preventDefault(); setCreatingView(false); resetDraft(); }
                }}
              />
              <div className="settings-field">
                <span className="settings-field-label">Priorities</span>
                {ALL_TIERS.map((n) => (
                  <button
                    key={n}
                    className={`pill${priorities.includes(n) ? " active" : ""}`}
                    onClick={() => toggleTier(n, priorities, setPriorities)}
                  >P{n}</button>
                ))}
              </div>
              <div className="settings-field">
                <span className="settings-field-label">Tasks from</span>
                {(["all", "agent", "mine"] as const).map((a) => (
                  <button
                    key={a}
                    className={`pill${agent === a ? " active" : ""}`}
                    onClick={() => setAgent(a)}
                  >{a === "all" ? "All" : a === "agent" ? "Agent" : "Mine"}</button>
                ))}
              </div>
              {features.projects && (
                <div className="settings-field">
                  <span className="settings-field-label">Project</span>
                  <button
                    className={`pill${projectId === null ? " active" : ""}`}
                    onClick={() => setProjectId(null)}
                  >Any</button>
                  {projects.map((p) => (
                    <button
                      key={p.id}
                      className={`pill${projectId === p.id ? " active" : ""}`}
                      onClick={() => setProjectId(projectId === p.id ? null : p.id)}
                    >{p.name}</button>
                  ))}
                </div>
              )}
              <div className="settings-field">
                <span className="settings-field-label">Notes</span>
                <button className={`pill${notes ? " active" : ""}`} onClick={() => setNotes(true)}>Show</button>
                <button className={`pill${!notes ? " active" : ""}`} onClick={() => setNotes(false)}>Hide</button>
              </div>
              {notes && (
                <div className="settings-field">
                  <span className="settings-field-label">Note tiers</span>
                  {ALL_TIERS.map((n) => (
                    <button
                      key={n}
                      className={`pill${notePriorities.includes(n) ? " active" : ""}`}
                      onClick={() => toggleTier(n, notePriorities, setNotePriorities)}
                    >P{n}</button>
                  ))}
                </div>
              )}
              <div className="settings-form-actions">
                <button className="pill" onClick={() => { setCreatingView(false); resetDraft(); }}>Cancel</button>
                <button className="settings-save" disabled={!name.trim()} onClick={create}>Create View</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

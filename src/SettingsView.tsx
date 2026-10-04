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

export type FeatureKey = "tasks" | "today" | "daily" | "backlog" | "notes" | "goals";

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
];

export default function SettingsView({
  features, onToggleFeature, projects, views, activeViewId,
  onToggleViewActive, onCreateView, onDeleteView,
  notesCard, tasksCard, onSetCard,
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
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [priorities, setPriorities] = useState<(1 | 2 | 3)[]>([1, 2, 3]);
  const [agent, setAgent] = useState<CustomView["agent"]>("all");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [notes, setNotes] = useState(true);
  const [notePriorities, setNotePriorities] = useState<(1 | 2 | 3)[]>([1, 2, 3]);

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
    setCreating(false);
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
          {!creating && (
            <div className="settings-row">
              <button className="settings-main" onClick={() => setCreating(true)}>
                <span className="settings-name">+ New View</span>
                <span className="settings-hint">combine priorities, agent, project, notes</span>
              </button>
            </div>
          )}
          {creating && (
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
                  else if (e.key === "Escape") { e.preventDefault(); setCreating(false); resetDraft(); }
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
                <button className="pill" onClick={() => { setCreating(false); resetDraft(); }}>Cancel</button>
                <button className="settings-save" disabled={!name.trim()} onClick={create}>Create View</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

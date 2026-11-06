// ViewsPane — named lenses over the display axes (Focus/Fun and any custom
// ones). Existence-gated like every feature: the master on the card title
// decides whether the app has lenses at all; off, none of it renders and
// no view rides ⌘P. The builder's summary line describes the lens as you
// click it.

import { useState } from "react";
import { clip, trace } from "../../logging/devlog";
import { viewSummary, type CustomView } from "../../lib/views";
import type { Project } from "../../types/project";
import { IconPencil, IconX } from "../../components/icons";
import type { FeatureKey } from "./vocab";
import { Group, InfoRow, Seg } from "./rows";

const ALL_TIERS = [1, 2, 3] as const;

export default function ViewsPane({
  features, projects, views, activeViewId, viewsEnabled, onToggleViewsEnabled,
  onToggleViewActive, onCreateView, onUpdateView, onDeleteView,
}: {
  features: Record<FeatureKey, boolean>;
  projects: Project[];
  views: CustomView[];
  activeViewId: string | null;
  viewsEnabled: boolean;
  onToggleViewsEnabled: (on: boolean) => void;
  onToggleViewActive: (id: string) => void;
  onCreateView: (view: CustomView) => void;
  onUpdateView: (id: string, view: CustomView) => void;
  onDeleteView: (id: string) => void;
}) {
  const [creatingView, setCreatingView] = useState(false);
  /** The view being edited (pencil on its card) — the form saves back into it. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [goals, setGoals] = useState(true);
  const [name, setName] = useState("");
  const [priorities, setPriorities] = useState<(1 | 2 | 3)[]>([1, 2, 3]);
  const [agent, setAgent] = useState<CustomView["agent"]>("all");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [sections, setSections] = useState({ today: true, daily: true, backlog: true });
  const [notes, setNotes] = useState(true);
  const [notePriorities, setNotePriorities] = useState<(1 | 2 | 3)[]>([1, 2, 3]);

  const resetDraft = () => {
    setEditingId(null);
    setName("");
    setPriorities([1, 2, 3]);
    setAgent("all");
    setProjectIds([]);
    setSections({ today: true, daily: true, backlog: true });
    setNotes(true);
    setGoals(true);
    setNotePriorities([1, 2, 3]);
  };

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const view: CustomView = {
      id: editingId ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      name: trimmed,
      priorities: [...priorities],
      agent,
      projectIds,
      goals,
      sections: { ...sections },
      notes,
      notePriorities: [...notePriorities],
    };
    if (editingId) {
      trace("views.update", { name: clip(trimmed) });
      onUpdateView(editingId, view);
    } else {
      trace("views.create", { name: clip(trimmed) });
      onCreateView(view);
    }
    resetDraft();
    setEditingId(null);
    setCreatingView(false);
  };

  /** Open the form pre-filled with a view's values — the edit path. */
  const edit = (id: string) => {
    const v = views.find((x) => x.id === id);
    if (!v) return;
    setName(v.name);
    setPriorities([...v.priorities]);
    setAgent(v.agent);
    setProjectIds([...v.projectIds]);
    setSections({ ...v.sections });
    setNotes(v.notes);
    setGoals(v.goals);
    setNotePriorities([...v.notePriorities]);
    setEditingId(id);
    setCreatingView(true);
  };

  const toggleTier = (
    n: 1 | 2 | 3,
    list: (1 | 2 | 3)[],
    set: (v: (1 | 2 | 3)[]) => void,
  ) => set(list.includes(n) ? list.filter((p) => p !== n) : [...list, n]);

  // The builder's live one-liner: the lens described as you click.
  const draftSummary = viewSummary(
    { id: "draft", name, priorities, agent, projectIds, notes, notePriorities, goals, sections },
    projects,
  );

  return (
    <Group
      title="Views"
      master={{
        on: viewsEnabled,
        hint: "the lenses — Focus, Fun, and any custom view",
        onToggle: () => {
          trace("views.toggle", { to: !viewsEnabled });
          onToggleViewsEnabled(!viewsEnabled);
        },
      }}
    >
      {viewsEnabled ? (
        <>
          <div className="set-views">
            {views.map((v) => {
              const active = activeViewId === v.id;
              return (
                <div
                  key={v.id}
                  role="button"
                  className={`set-view-card${active ? " on" : ""}`}
                  onClick={() => {
                    trace("views.activate", { name: clip(v.name), to: !active });
                    onToggleViewActive(v.id);
                  }}
                >
                  <span className="set-view-text">
                    <span className="set-view-name">{v.name}</span>
                    <span className="set-view-sum">{viewSummary(v, projects)}</span>
                  </span>
                  <span className={`set-state${active ? " on" : ""}`}>{active ? "Active" : "Enter"}</span>
                  <span className="set-view-act">
                    <button
                      className="set-edit"
                      title="Edit view"
                      aria-label={`Edit ${v.name}`}
                      onClick={(e) => { e.stopPropagation(); edit(v.id); }}
                    ><IconPencil /></button>
                    <button
                      className="set-x"
                      title="Delete view"
                      aria-label={`Delete ${v.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        trace("views.delete", { name: clip(v.name) });
                        onDeleteView(v.id);
                      }}
                    ><IconX /></button>
                  </span>
                </div>
              );
            })}
          </div>
          {!creatingView && (
            <button
              className="set-new"
              title="Combine priorities, agent, project, notes"
              onClick={() => setCreatingView(true)}
            >
              <b>+</b> New view
            </button>
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
                if (e.key === "Enter") { e.preventDefault(); save(); }
                else if (e.key === "Escape") { e.preventDefault(); setCreatingView(false); resetDraft(); }
              }}
            />
            <div className="set-form-summary">{draftSummary || "everything"}</div>
            {features.taskPriorities && (
              <div className="settings-field">
                <span className="settings-field-label">Priorities</span>
                {ALL_TIERS.map((n) => (
                  <button
                    key={n}
                    className={`set-chip${priorities.includes(n) ? " on" : ""}`}
                    onClick={() => toggleTier(n, priorities, setPriorities)}
                  >P{n}</button>
                ))}
              </div>
            )}
            <div className="settings-field">
              <span className="settings-field-label">Sections</span>
              {([["today", "Today"], ["daily", "Daily"], ["backlog", "Backlog"]] as const).map(
                ([sec, label]) => (
                  <button
                    key={sec}
                    className={`set-chip${sections[sec] ? " on" : ""}`}
                    onClick={() => setSections((sc) => ({ ...sc, [sec]: !sc[sec] }))}
                  >{label}</button>
                ),
              )}
            </div>
            <div className="settings-field">
              <span className="settings-field-label">Tasks from</span>
              <Seg
                value={agent}
                options={[{ v: "all", label: "All" }, { v: "agent", label: "Agent" }, { v: "mine", label: "Mine" }]}
                onPick={(v) => setAgent(v as CustomView["agent"])}
              />
            </div>
            {(features.taskProjects || features.noteProjects) && (
              <div className="settings-field">
                <span className="settings-field-label">Projects</span>
                <button
                  className={`set-chip${projectIds.length === 0 ? " on" : ""}`}
                  onClick={() => setProjectIds([])}
                >Any</button>
                {projects.map((p) => (
                  <button
                    key={p.id}
                    className={`set-chip${projectIds.includes(p.id) ? " on" : ""}`}
                    onClick={() => setProjectIds((ids) =>
                      ids.includes(p.id) ? ids.filter((x) => x !== p.id) : [...ids, p.id],
                    )}
                  >{p.name}</button>
                ))}
              </div>
            )}
            {features.notes && (
              <div className="settings-field">
                <span className="settings-field-label">Notes</span>
                <Seg
                  value={notes ? "show" : "hide"}
                  options={[{ v: "show", label: "Show" }, { v: "hide", label: "Hide" }]}
                  onPick={(v) => setNotes(v === "show")}
                />
              </div>
            )}
            {features.goals && (
              <div className="settings-field">
                <span className="settings-field-label">Goals</span>
                <Seg
                  value={goals ? "show" : "hide"}
                  options={[{ v: "show", label: "Show" }, { v: "hide", label: "Hide" }]}
                  onPick={(v) => setGoals(v === "show")}
                />
              </div>
            )}
            {features.notes && features.notePriorities && (
              <div className="settings-field">
                <span className="settings-field-label">Note tiers</span>
                {ALL_TIERS.map((n) => (
                  <button
                    key={n}
                    className={`set-chip${notePriorities.includes(n) ? " on" : ""}`}
                    onClick={() => toggleTier(n, notePriorities, setNotePriorities)}
                  >P{n}</button>
                ))}
              </div>
            )}
            <div className="settings-form-actions">
              <button className="pill" onClick={() => { setCreatingView(false); resetDraft(); }}>Cancel</button>
              <button className="settings-save" disabled={!name.trim()} onClick={save}>{editingId ? "Save Changes" : "Create View"}</button>
            </div>
          </div>
        )}
        </>
      ) : (
        <InfoRow label="No lenses" hint="turn Views on to enter Focus, Fun, or a custom view" />
      )}
    </Group>
  );
}

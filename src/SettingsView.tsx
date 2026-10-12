// SettingsView — the settings page (⌘P → Settings). One console column over
// flat hairline groups (2026-10-12, the settings-look v2 mockup): real
// switches and segmented controls instead of ON/OFF text, themes as ladder
// cards (the eleven shades in editor order), views as cards with an
// Active/Enter state, and the view builder with a live "shows …" summary.
//
// Rows are dependency-aware: a feature that's off sends its dependents inert
// with a hint saying why — the section toggles and Agent delegation need
// Tasks, daily pause needs Daily, the Goal actions need Goals, the Header's
// Hidden button needs any archive axis, Journal/Quotes need their features,
// the screensaver needs Quotes. The same gates App applies when rendering,
// now visible at the control itself.
//
// Mouse-first like Analytics: no focus-grammar wiring (free-mode j/k
// scrolling works globally, Esc closes the page).

import { useState } from "react";
import { type Project } from "./lib";
import { clip, trace } from "./devlog";
import { BUILT_IN_THEMES, COLOR_FIELDS, applyTheme, type Theme, type ThemeColors } from "./themes";
import { IconPencil, IconX } from "./components/icons";

export type FeatureKey =
  | "tasks" | "today" | "daily" | "backlog" | "notes" | "goals" | "journal" | "quotes"
  | "taskProjects" | "noteProjects" | "goalProjects"
  | "taskPriorities" | "notePriorities" | "agent" | "timer" | "reminders"
  | "taskHide" | "dailyPause" | "noteHide" | "goalPause"
  | "taskDetails" | "noteDownload";

// The header's icon buttons — each an On/Off choice in the Header group.
export type HeaderBtn = "hidden" | "analytics" | "journal" | "quotes" | "settings" | "theme";

// `need` lists the features the button reads — the row goes inert only when
// ALL of them are off (the ◐ button works while any archive axis exists).
const HEADER_BUTTONS: { key: HeaderBtn; label: string; hint: string; need?: FeatureKey[] }[] = [
  { key: "hidden", label: "Hidden entries", hint: "the ◐ archive peek", need: ["taskHide", "dailyPause", "noteHide", "goalPause"] },
  { key: "analytics", label: "Analytics", hint: "the chart icon" },
  { key: "journal", label: "Journal", hint: "the prose icon", need: ["journal"] },
  { key: "quotes", label: "Quotes", hint: "the quote icon", need: ["quotes"] },
  { key: "settings", label: "Settings", hint: "the gear icon" },
  { key: "theme", label: "Theme cycle", hint: "the droplet — walks every theme, subscript = position" },
];

export interface CustomView {
  id: string;
  name: string;
  // The tiers the lens keeps; a missing tier is hidden while the view is
  // active. Unmarked rows are never touched (the ⌘P tier rule).
  priorities: (1 | 2 | 3)[];
  // The delegation axis: all | agent (🤖 rows only) | mine.
  agent: "all" | "agent" | "mine";
  // The project scope: rows from ANY of these (OR within the axis); empty =
  // all projects.
  projectIds: string[];
  notes: boolean;
  notePriorities: (1 | 2 | 3)[];
  // Whether the Goals layer renders in this view.
  goals: boolean;
  // Which task sections the view keeps.
  sections: { today: boolean; daily: boolean; backlog: boolean };
}

/** Older stores kept a single `projectId` and no goals/sections — normalize
 *  on read. */
export const normalizeView = (
  v: CustomView & { projectId?: string | null },
): CustomView => ({
  ...v,
  projectIds: v.projectIds ?? (v.projectId ? [v.projectId] : []),
  goals: v.goals ?? true,
  sections: v.sections ?? { today: true, daily: true, backlog: true },
});

const ALL_TIERS = [1, 2, 3] as const;

/** The two classic lenses, seeded as real (editable, deletable) views on
 *  first load. Their definitions are data now — edit them by recreating, or
 *  delete them and they leave ⌘P with the rest. */
export const SEED_VIEWS: CustomView[] = [
  {
    id: "view-focus", name: "Focus",
    priorities: [1], agent: "all", projectIds: [],
    notes: true, notePriorities: [1], goals: false,
    sections: { today: true, daily: true, backlog: true },
  },
  {
    id: "view-fun", name: "Fun",
    priorities: [3], agent: "all", projectIds: [],
    notes: true, notePriorities: [3], goals: true,
    sections: { today: true, daily: false, backlog: true },
  },
];

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
  if (v.projectIds.length > 0) {
    const names = v.projectIds
      .map((id) => projects.find((p) => p.id === id)?.name ?? "project")
      .map((n) => `#${n}`);
    parts.push(names.length <= 3 ? names.join("+") : `${names.length} projects`);
  }
  if (!v.notes) parts.push("no notes");
  else if (v.notePriorities.length < 3) {
    parts.push(v.notePriorities.length === 0
      ? "no note tiers"
      : `notes ${[...v.notePriorities].sort().map((p) => `P${p}`).join("+")}`);
  }
  if (!v.goals) parts.push("no goals");
  const dropped = (["today", "daily", "backlog"] as const)
    .filter((sec) => !v.sections[sec])
    .map((sec) => `no ${sec}`);
  if (dropped.length < 3) parts.push(...dropped);
  return parts.join(" · ");
};

// The Features area is four cards: the surfaces (what exists at all), then
// the actions that belong to one surface — tasks, notes, goals.
const FEATURE_GROUPS = [
  { id: "features", title: "Features" },
  { id: "taskActions", title: "Task actions" },
  { id: "noteActions", title: "Note actions" },
  { id: "goalActions", title: "Goal actions" },
] as const;

const FEATURES: { key: FeatureKey; label: string; hint: string; group: (typeof FEATURE_GROUPS)[number]["id"] }[] = [
  { key: "tasks", label: "Tasks", hint: "capture + all three sections", group: "features" },
  { key: "today", label: "Today", hint: "section", group: "features" },
  { key: "daily", label: "Daily", hint: "section", group: "features" },
  { key: "backlog", label: "Backlog", hint: "section", group: "features" },
  { key: "notes", label: "Notes", hint: "the notepad surface", group: "features" },
  { key: "goals", label: "Goals", hint: "the identity layer", group: "features" },
  { key: "journal", label: "Journal", hint: "##j entries + the page", group: "features" },
  { key: "quotes", label: "Quotes", hint: "##q entries, the page + the idle moment", group: "features" },
  { key: "timer", label: "Timer", hint: "per-task time tracking (▶ / ⏱)", group: "taskActions" },
  { key: "reminders", label: "Reminders", hint: "the ◷ date that pulls a row to Today", group: "taskActions" },
  { key: "taskProjects", label: "Task projects", hint: "the #tag axis + the row's label", group: "taskActions" },
  { key: "taskHide", label: "Task hide", hint: "soft-archive Today + Backlog rows (◐)", group: "taskActions" },
  { key: "dailyPause", label: "Pause daily tasks", hint: "the ◐ pause on Daily habits — auto-resumes at its date", group: "taskActions" },
  { key: "taskDetails", label: "Task details", hint: "the ⋯ spec body under a task", group: "taskActions" },
  { key: "taskPriorities", label: "Task priorities", hint: "the !1–!3 tiers + signal bars", group: "taskActions" },
  { key: "agent", label: "Agent delegation", hint: "the @ axis — 🤖 badge + the agent queue", group: "taskActions" },
  { key: "noteProjects", label: "Note projects", hint: "the #tag footer token + the collapsed label", group: "noteActions" },
  { key: "notePriorities", label: "Note priorities", hint: "the !N footer tiers on notes", group: "noteActions" },
  { key: "noteHide", label: "Note hide", hint: "soft-archive notes (◐)", group: "noteActions" },
  { key: "noteDownload", label: "Note download", hint: "the ⬇ .txt export on notes", group: "noteActions" },
  { key: "goalProjects", label: "Goal projects", hint: "the #tag link on a goal", group: "goalActions" },
  { key: "goalPause", label: "Goal pause", hint: "set a goal down — the ◐ with an expiry, resumed by ↺", group: "goalActions" },
];

// Rows whose switch is pointless while another feature is off — the row goes
// inert and its hint says why. (The Header group's gates ride each entry's
// `need`; the screensaver's is hard-coded in its row.)
const GATED_BY: Partial<Record<FeatureKey, FeatureKey>> = {
  today: "tasks",
  daily: "tasks",
  backlog: "tasks",
  agent: "tasks",
  dailyPause: "daily",
  goalProjects: "goals",
  goalPause: "goals",
};

// ---- Row primitives --------------------------------------------------------

/** A switch row: the whole row is the click target; the switch is its state.
 *  `needs` dims the row inert while that feature is off, and the hint says
 *  why — the same gates App applies when rendering, visible at the control. */
function ToggleRow({
  label, hint, on, needs, needsLabel, onToggle,
}: {
  label: string;
  hint: string;
  on: boolean;
  needs?: boolean;      // true while the gate feature is off
  needsLabel?: string;  // the gate feature's name, for the hint
  onToggle: () => void;
}) {
  return (
    <div
      className={`set-row${needs ? " dep" : ""}`}
      role="switch"
      aria-checked={on}
      aria-disabled={needs || undefined}
      onClick={needs ? undefined : onToggle}
    >
      <span className="set-row-text">
        <span className="set-name">{label}</span>
        <span className="set-hint">
          {needs ? `needs ${needsLabel} — off in Features` : hint}
        </span>
      </span>
      <span className={`set-sw${on ? " on" : ""}`} />
    </div>
  );
}

/** A plain row: label over hint, anything at the right (a Seg, a swatch).
 *  Same `needs` dimming as the switch rows — inert while the gate is off. */
function InfoRow({ label, hint, needs, needsLabel, children }: {
  label: string;
  hint: string;
  needs?: boolean;
  needsLabel?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={`set-row${needs ? " dep" : ""}`} aria-disabled={needs || undefined}>
      <span className="set-row-text">
        <span className="set-name">{label}</span>
        <span className="set-hint">
          {needs ? `needs ${needsLabel} — off in Features` : hint}
        </span>
      </span>
      {children}
    </div>
  );
}

/** Segmented control — exclusive choices in one hairline box. */
function Seg({ value, options, onPick }: {
  value: string;
  options: { v: string; label: string }[];
  onPick: (v: string) => void;
}) {
  return (
    <span className="set-seg" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.v}
          role="radio"
          aria-checked={o.v === value}
          className={o.v === value ? "on" : ""}
          onClick={(e) => { e.stopPropagation(); onPick(o.v); }}
        >{o.label}</button>
      ))}
    </span>
  );
}

/** Group: a card — the analytics card language — under its uppercase title. */
function Group({ title, count, children }: {
  title: string;
  count?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="an-card">
      <div className="an-card-title">
        {title}
        {count && <span className="set-count">{count}</span>}
      </div>
      {children}
    </section>
  );
}

export default function SettingsView({
  features, onToggleFeature, projects, views, activeViewId,
  onToggleViewActive, onCreateView, onUpdateView, onDeleteView,
  notesCard, tasksCard, onSetCard, screensaverMins, onSetScreensaverMins, headerBtns, onToggleHeaderBtn,
  themeId, customThemes, onActivateTheme, onCreateTheme, onDeleteTheme,
}: {
  features: Record<FeatureKey, boolean>;
  onToggleFeature: (key: FeatureKey) => void;
  projects: Project[];
  views: CustomView[];
  activeViewId: string | null;
  onToggleViewActive: (id: string) => void;
  onCreateView: (view: CustomView) => void;
  onUpdateView: (id: string, view: CustomView) => void;
  onDeleteView: (id: string) => void;
  notesCard: boolean;
  tasksCard: boolean;
  onSetCard: (surface: "notes" | "tasks", card: boolean) => void;
  screensaverMins: number;
  onSetScreensaverMins: (mins: number) => void;
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

  const toggle = (key: FeatureKey) => {
    trace("toggle.feature", { feature: key, to: !features[key] });
    onToggleFeature(key);
  };

  // The builder's live one-liner: the lens described as you click.
  const draftSummary = viewSummary(
    { id: "draft", name, priorities, agent, projectIds, notes, notePriorities, goals, sections },
    projects,
  );

  return (
    <div className="settings">
      {/* ---- The Features area: surfaces first, then each surface's
              actions. The three section toggles go inert while Tasks is off. ---- */}
      {FEATURE_GROUPS.map((g) => {
        const rows = FEATURES.filter((f) => f.group === g.id);
        return (
          <Group
            key={g.id}
            title={g.title}
            count={`${rows.filter((f) => features[f.key]).length} of ${rows.length} on`}
          >
            <div className="set-rows">
              {rows.map(({ key, label, hint }) => {
                const gate = GATED_BY[key];
                return (
                  <ToggleRow
                    key={key}
                    label={label}
                    hint={hint}
                    on={features[key]}
                    needs={gate && !features[gate] ? true : undefined}
                    needsLabel={gate ? FEATURES.find((f) => f.key === gate)?.label : undefined}
                    onToggle={() => toggle(key)}
                  />
                );
              })}
            </div>
          </Group>
        );
      })}

      {/* ---- Header: which icon buttons mount top-right. Off hides only the
              button; the view stays in ⌘P (the two-layers rule). ---- */}
      <Group
        title="Header"
        count={`${HEADER_BUTTONS.filter((b) => headerBtns[b.key]).length} of ${HEADER_BUTTONS.length} shown`}
      >
        <div className="set-rows">
          {HEADER_BUTTONS.map(({ key, label, hint, need }) => (
            <ToggleRow
              key={key}
              label={label}
              hint={hint}
              on={headerBtns[key]}
              needs={need && need.every((k) => !features[k]) ? true : undefined}
              needsLabel={need ? need.map((k) => FEATURES.find((f) => f.key === k)?.label).join(" or ") : undefined}
              onToggle={() => {
                trace("toggle.header", { btn: key, to: !headerBtns[key] });
                onToggleHeaderBtn(key);
              }}
            />
          ))}
        </div>
      </Group>

      {/* ---- Appearance: one look card — the resting fills, the idle
              moment, then themes as ladder cards (the eleven shades in
              editor order, so a theme reads at a glance). ---- */}
      <Group title="Appearance">
        <div className="set-rows">
          <InfoRow label="Notes background" hint="the fill behind each note">
            <span className={`set-swatch${notesCard ? " filled" : " empty"}`} />
            <Seg
              value={notesCard ? "card" : "bare"}
              options={[{ v: "card", label: "Card" }, { v: "bare", label: "Bare" }]}
              onPick={(v) => { trace("ui.card", { surface: "notes", to: v === "card" }); onSetCard("notes", v === "card"); }}
            />
          </InfoRow>
          <InfoRow label="Tasks background" hint="the fill behind each row">
            <span className={`set-swatch${tasksCard ? " filled" : " empty"}`} />
            <Seg
              value={tasksCard ? "card" : "bare"}
              options={[{ v: "card", label: "Card" }, { v: "bare", label: "Bare" }]}
              onPick={(v) => { trace("ui.card", { surface: "tasks", to: v === "card" }); onSetCard("tasks", v === "card"); }}
            />
          </InfoRow>
          <InfoRow
            label="Quote screensaver"
            hint={`${screensaverMins} min idle before a quote appears`}
            needs={!features.quotes}
            needsLabel="Quotes"
          >
            <Seg
              value={String(screensaverMins)}
              options={[1, 2, 5, 10].map((m) => ({ v: String(m), label: `${m}m` }))}
              onPick={(v) => { trace("ui.screensaver", { mins: Number(v) }); onSetScreensaverMins(Number(v)); }}
            />
          </InfoRow>
        </div>
        <div className="set-theme-grid">
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

      {/* ---- Views: named lenses over the display axes. The builder's
              summary line describes the lens as you click it. ---- */}
      <Group title="Views">
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
      </Group>
    </div>
  );
}

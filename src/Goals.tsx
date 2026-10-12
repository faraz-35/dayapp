// Goals — the identity layer at the top of the main page: statements of
// direction at three horizons (Timeless → Long term → Short term, achieved
// goals last). The timescale stack tops out here: timers (seconds) → items
// (days) → goals (months → never). Like items, goals are state + logged
// activity — every mutation appends to `actions` (goal_* values, plus the
// shared paused/unpaused verbs for a pause; see goals.rs); only the project
// link is housekeeping.
//
// Self-contained like Notes: owns its state, API, and handlers. Not part of
// the DnD area — goals are a calm static list, not a reorderable one. The
// projects list and project creation come from App (its projects state is the
// single source — a project created here must land there immediately).
//
// Capture syntax (parseGoalText in lib.ts): a leading horizon word sets the
// tier ("timeless be a better person"), defaulting to short; `#tag` project
// tokens work exactly like item capture. Same rules on edit — no horizon word
// leaves the tier alone.

import { useEffect, useState } from "react";
import {
  formatGoalAchieved,
  formatReminder,
  goalsApi,
  hideExpiry,
  parseGoalText,
  projectColor,
  type Goal,
  type GoalHorizon,
  type HiddenFilter,
  type HideDuration,
  type Project,
} from "./lib";
import { log } from "./log";
import { clip, trace } from "./devlog";
import { useFeatures } from "./features";
import HideMenu from "./HideMenu";
import ProjectMenu from "./ProjectMenu";
import TokenField from "./TokenField";
import { EditInput } from "./components/ItemRow";
import { IconUndo, IconX } from "./components/icons";

// Display order: constitution → career → now. A group with no goals renders
// no divider (derived from the rendered list, like the Backlog's tier
// dividers).
const HORIZON_GROUPS: { horizon: GoalHorizon; label: string }[] = [
  { horizon: "timeless", label: "Timeless" },
  { horizon: "long", label: "Long term" },
  { horizon: "short", label: "Short term" },
];

export default function Goals({
  projects, onCreateProject, focusedId, reloadEpoch = 0, hiddenFilter = "exclude",
}: {
  projects: Project[];
  onCreateProject: (name: string) => Promise<Project>;
  focusedId?: string | null;
  /** Bumps when the whole database is swapped under the app (demo mode). */
  reloadEpoch?: number;
  /** The ⌘P reveal: include renders paused goals inline, dimmed (the
      hidden-task render); exclude (default) keeps them out of the list. */
  hiddenFilter?: HiddenFilter;
}) {
  const features = useFeatures();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    goalsApi.list(hiddenFilter).then(setGoals).catch((e) => log.error("goals load failed", e));
  }, [reloadEpoch, hiddenFilter]);

  // Optimistic patch helper — mutations keep the flat list's order truthful
  // (sort_order never changes optimistically), and the horizon grouping
  // derives from it, so the optimistic render is what a refresh returns.
  const patchGoal = (id: string, patch: Partial<Goal>) =>
    setGoals((g) => g.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const submit = async () => {
    const raw = draft.trim();
    setDraft("");
    if (!raw) return;
    const { text, horizon, projectId, createProjectName } = parseGoalText(raw, projects, { projects: features.projects });
    if (!text) return;
    trace("capture.goal", { horizon: horizon ?? "short", text: clip(text) });
    try {
      // Materialize a trailing unmatched #tag's project first so the create
      // lands with its assignment (items assign after create; goals take
      // project_id on the insert itself).
      const assignId = projectId ?? (createProjectName ? (await onCreateProject(createProjectName)).id : null);
      // No horizon word = short, the default tier. The create returns the
      // authoritative row, so the optimistic append can't drift.
      const created = await goalsApi.create(text, horizon ?? "short", assignId);
      setGoals((g) => [...g, created]);
    } catch (e) {
      log.error("goal create failed", e);
    }
  };

  const handleCommitEdit = async (goal: Goal, raw: string) => {
    setEditingId(null);
    const { text, horizon, projectId, createProjectName } = parseGoalText(raw, projects, { projects: features.projects });
    if (!text) return;
    try {
      const assignId = projectId ?? (createProjectName ? (await onCreateProject(createProjectName)).id : null);
      // Apply the stripped text; a horizon word moves the row between groups
      // (the grouping derives), no word leaves the tier alone; a #tag
      // overrides the project, none leaves the assignment alone.
      patchGoal(goal.id, {
        text,
        ...(horizon ? { horizon } : {}),
        ...(assignId ? { projectId: assignId } : {}),
      });
      await goalsApi.edit(goal.id, text, horizon);
      if (assignId) goalsApi.setProject(goal.id, assignId);
    } catch (e) {
      log.error("goal edit failed", e);
    }
  };

  const handleAchieve = async (goal: Goal) => {
    // The backend rejects timeless goals (a direction, never done) — the UI
    // never offers the checkbox there, this guards the rest.
    if (goal.horizon === "timeless") return;
    trace("goal.achieve", { text: clip(goal.text), horizon: goal.horizon });
    patchGoal(goal.id, { status: "achieved", achievedAt: new Date().toISOString() });
    try { await goalsApi.achieve(goal.id); }
    catch (e) { log.error("goal achieve failed", e); }
  };

  const handleUnachieve = async (goal: Goal) => {
    trace("goal.unachieve", { text: clip(goal.text) });
    patchGoal(goal.id, { status: "active", achievedAt: null });
    try { await goalsApi.unachieve(goal.id); }
    catch (e) { log.error("goal unachieve failed", e); }
  };

  const handleDelete = async (goal: Goal) => {
    trace("goal.delete", { text: clip(goal.text), horizon: goal.horizon });
    setGoals((g) => g.filter((x) => x.id !== goal.id));
    try { await goalsApi.delete(goal.id); }
    catch (e) { log.error("goal delete failed", e); }
  };

  // Pause a goal — the same soft-archive tasks/notes use, worded "pause" on
  // this surface. With the ⌘P reveal on, the row stays put flipped to its
  // hidden render (hideExpiry mirrors the backend's date math so the chip is
  // right immediately); off, it leaves the list — the next refresh would
  // exclude it anyway.
  const handlePause = async (goal: Goal, duration: HideDuration) => {
    trace("goal.pause", { text: clip(goal.text), duration });
    if (hiddenFilter === "include") {
      patchGoal(goal.id, { hidden: true, hiddenUntil: hideExpiry(duration) });
    } else {
      setGoals((g) => g.filter((x) => x.id !== goal.id));
    }
    try { await goalsApi.pause(goal.id, duration); }
    catch (e) { log.error("goal pause failed", e); }
  };

  // Resume a paused goal (↺, or the expiry sweep on its own).
  const handleResume = async (goal: Goal) => {
    trace("goal.unpause", { text: clip(goal.text) });
    if (hiddenFilter === "include") {
      patchGoal(goal.id, { hidden: false, hiddenUntil: null });
    } else {
      setGoals((g) => g.filter((x) => x.id !== goal.id));
    }
    try { await goalsApi.resume(goal.id); }
    catch (e) { log.error("goal resume failed", e); }
  };

  const handleSetProject = async (goal: Goal, projectId: string | null) => {
    patchGoal(goal.id, { projectId });
    try { await goalsApi.setProject(goal.id, projectId); }
    catch (e) { log.error("goal project assign failed", e); }
  };

  const renderRow = (goal: Goal) => {
    const achieved = goal.status === "achieved";
    const paused = goal.hidden;
    const project = projects.find((p) => p.id === goal.projectId) ?? null;
    const editing = editingId === goal.id;
    // Digit slots, left to right: ✓ always 1; then # (when projects exist),
    // ◐ pause (active rows only), × last. Paused rows render only ↺ + ×.
    const pauseKb = features.projects ? "3" : "2";
    const deleteKb = features.projects ? "4" : "3";
    return (
      <div
        key={goal.id}
        data-goal-id={goal.id}
        className={`item goal-row${achieved ? " done" : ""}${paused ? " hidden" : ""}${focusedId === goal.id ? " focused" : ""}`}
        onClick={() => { if (!editing) setEditingId(goal.id); }}
      >
        {/* Task rows' leading grip slot, mirrored so the circle and text
            columns line up across both surfaces. Goals have no DnD — the
            glyph never reveals, not even on hover: a spacer, never a
            handle (the details-body precedent). */}
        <span className="grip" aria-hidden="true">⠿</span>
        {goal.horizon === "timeless" ? (
          <span
            className="goal-eternal"
            title="Timeless — a direction, never done"
          >∞</span>
        ) : (
          <button
            className={`item-check${achieved ? " checked" : ""}`}
            {...(paused ? {} : { "data-kb": "1" })}
            onClick={(e) => {
              e.stopPropagation();
              if (paused) return;
              achieved ? handleUnachieve(goal) : handleAchieve(goal);
            }}
            title={paused
              ? "Paused — hover for ↺ resume"
              : achieved ? "Achieved — click to undo" : "Mark achieved"}
            aria-label="Mark achieved"
          />
        )}

        {editing ? (
          <EditInput initial={goal.text} onCommit={(text) => handleCommitEdit(goal, text)} kinds={features.projects ? ["project"] : []} />
        ) : (
          <span className="item-text">{goal.text}</span>
        )}

        {!editing && (
          <>
            {/* Right-aligned metadata, same slots as item rows: the paused
                chip / achieved date (fade on hover like time labels) + the
                project label (stays visible — the row's identity). The empty
                meta div still pushes the actions flush right. */}
            <div className="item-meta">
              {paused && (
                <span
                  className="hidden-chip"
                  title={goal.hiddenUntil
                    ? `Paused until ${goal.hiddenUntil}`
                    : "Paused forever — hover for ↺ resume"}
                >
                  ◐ {goal.hiddenUntil ? `until ${formatReminder(goal.hiddenUntil)}` : "forever"}
                </span>
              )}
              {achieved && goal.achievedAt && (
                <span
                  className="time-label"
                  title={`Achieved ${goal.achievedAt.slice(0, 10)}`}
                >{formatGoalAchieved(goal.achievedAt)}</span>
              )}
              {project && (
                <span
                  className="project-label"
                  style={{ color: projectColor(project.id) }}
                  title={`Project: ${project.name}`}
                >{project.name}</span>
              )}
            </div>
            {paused ? (
              <>
                <button
                  className="item-action unhide-btn"
                  data-kb="1"
                  onClick={(e) => { e.stopPropagation(); handleResume(goal); }}
                  title="Resume"
                  aria-label="Resume goal"
                ><IconUndo /></button>
                <button
                  className="item-action danger"
                  data-kb="2"
                  onClick={(e) => { e.stopPropagation(); handleDelete(goal); }}
                  title="Delete goal"
                  aria-label="Delete goal"
                ><IconX /></button>
              </>
            ) : (
              <>
                {features.projects && (
                  <ProjectMenu
                    kb="2"
                    projects={projects}
                    projectId={goal.projectId}
                    onAssign={(projectId) => handleSetProject(goal, projectId)}
                    onCreateProject={onCreateProject}
                  />
                )}
                {/* Pause rides the Goals feature (no separate switch) — an
                    achieved row has nothing to pause, so it keeps just ✓/#/×. */}
                {!achieved && (
                  <HideMenu
                    kb={pauseKb}
                    onHide={(duration) => handlePause(goal, duration)}
                    verb="Pause"
                  />
                )}
                <button
                  className="item-action danger"
                  data-kb={deleteKb}
                  onClick={(e) => { e.stopPropagation(); handleDelete(goal); }}
                  title="Delete goal"
                  aria-label="Delete goal"
                ><IconX /></button>
              </>
            )}
          </>
        )}
      </div>
    );
  };

  const active = (horizon: GoalHorizon) =>
    goals.filter((g) => g.horizon === horizon && g.status === "active");
  const achieved = goals.filter((g) => g.status === "achieved");

  return (
    <section className="goals section">
      <div
        className="section-head"
        title="Short (months) · Long (years) · Timeless (a direction, never done)"
      >
        <span className="section-name">Goals</span>
      </div>

      {/* Always-open capture, line-only like the section inputs — no
          placeholder, the line is the affordance. #tag tokens color while
          you type (TokenField); the leading horizon word is prose, not a
          sigil token, and stays plain. */}
      <div className="capture">
        <TokenField
          kinds={features.projects ? ["project"] : []}
          value={draft}
          onChange={setDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); submit(); }
            // Empty draft → blur: the Esc ladder's editing → nothing rung
            // for captures (a capture input isn't a grammar focus target).
            else if (e.key === "Escape") {
              if (draft) setDraft("");
              else e.currentTarget.blur();
            }
          }}
        />
      </div>

      {goals.length === 0 && (
        <div className="empty">What are you building toward? e.g. “timeless be a better person”.</div>
      )}

      {HORIZON_GROUPS.map(({ horizon, label }) =>
        active(horizon).length > 0 ? (
          <div key={horizon}>
            <div className="tier-divider">
              <span className="tier-label">{label}</span>
            </div>
            {active(horizon).map(renderRow)}
          </div>
        ) : null,
      )}

      {achieved.length > 0 && (
        <div>
          <div className="tier-divider">
            <span className="tier-label">Achieved</span>
          </div>
          {achieved.map(renderRow)}
        </div>
      )}
    </section>
  );
}

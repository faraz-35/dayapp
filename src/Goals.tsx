// Goals — the identity layer at the top of the main page: statements of
// direction at three horizons (Timeless → Long term → Short term, achieved
// goals last). The timescale stack tops out here: timers (seconds) → items
// (days) → goals (months → never). Like items, goals are state + logged
// activity — every mutation appends to `actions` (goal_* values, plus the
// shared paused/unpaused verbs for a pause; see goals.rs); only the project
// link is housekeeping.
//
// Self-contained like Notes: owns its state, API, and handlers. Horizons are
// drag targets like the task sections: grip-drag a row between groups to
// change its horizon (logged `goal_edited` with the from/to pair, the same
// entry the leading-word edit writes) or within one to reorder (unlogged).
// Achieved and paused rows sit out the drag. The projects list and project
// creation come from App (its projects state is the single source — a
// project created here must land there immediately).
//
// Capture syntax (parseGoalText in lib.ts): a `$1/$2/$3` token sets the tier
// ($1 short · $2 long · $3 timeless), defaulting to short; `#tag` project
// tokens work exactly like item capture. Same rules on edit — no token
// leaves the tier alone.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCorners,
  useDroppable,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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
  projects, onCreateProject, focusedId, reloadEpoch = 0, hiddenFilter = "exclude", demo = false,
}: {
  projects: Project[];
  onCreateProject: (name: string) => Promise<Project>;
  focusedId?: string | null;
  /** Bumps when the whole database is swapped under the app (demo mode). */
  reloadEpoch?: number;
  /** The ⌘P reveal: include renders paused goals inline, dimmed (the
      hidden-task render); exclude (default) keeps them out of the list. */
  hiddenFilter?: HiddenFilter;
  /** Demo mode: the capture teaches its grammar with rotating example lines
      while it sits empty (TokenField's demoExamples). */
  demo?: boolean;
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

  // ---- Horizon drag -------------------------------------------------------
  //
  // Same shape as the task stack: pointer drag on the grip, 4px activation,
  // closest-corners targeting. The sortable population of a horizon is its
  // visible (active, un-paused) rows — the same set move_goal re-indexes — so
  // the drop index means the same thing on both sides.

  const [activeDrag, setActiveDrag] = useState<Goal | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const findGoal = useCallback(
    (id: string) => goals.find((g) => g.id === id),
    [goals],
  );

  // A horizon's draggable rows, in display order.
  const dragGroup = useCallback(
    (horizon: GoalHorizon) =>
      goals.filter((g) => g.horizon === horizon && g.status === "active" && !g.hidden),
    [goals],
  );

  const onDragStart = (e: DragStartEvent) => {
    const goal = findGoal(e.active.id as string);
    if (goal) {
      trace("drag.start", { text: clip(goal.text), horizon: goal.horizon });
      setActiveDrag(goal);
    }
  };

  const onDragEnd = (e: DragEndEvent) => {
    setActiveDrag(null);
    const dragged = findGoal(e.active.id as string);
    if (!dragged || dragged.status !== "active" || dragged.hidden) return;
    if (!e.over) {
      trace("drag.cancel", { text: clip(dragged.text), why: "no target" });
      return;
    }

    // `over.id` is either a goal id, or a horizon dropzone (dropped on an
    // empty stretch of the group).
    const overId = String(e.over.id);
    let overHorizon: GoalHorizon;
    let newIndex: number;
    if (overId.startsWith("goalzone-")) {
      overHorizon = overId.replace("goalzone-", "") as GoalHorizon;
      newIndex = dragGroup(overHorizon).length;
    } else {
      const overGoal = findGoal(overId);
      if (!overGoal || overGoal.status !== "active" || overGoal.hidden) return;
      overHorizon = overGoal.horizon as GoalHorizon;
      newIndex = dragGroup(overHorizon).findIndex((g) => g.id === overId);
      if (newIndex === -1) newIndex = dragGroup(overHorizon).length;
    }

    // No-op if dropped in place.
    const currentIdx = dragGroup(dragged.horizon as GoalHorizon).findIndex((g) => g.id === dragged.id);
    if (overHorizon === dragged.horizon && currentIdx === newIndex) {
      trace("drag.cancel", { text: clip(dragged.text), why: "dropped in place" });
      return;
    }

    trace("drag.drop", { text: clip(dragged.text), from: dragged.horizon, to: overHorizon, index: newIndex });
    handleMoveGoal(dragged.id, overHorizon, newIndex);
  };

  // The drag's optimistic move: the destination group re-ordered with the
  // row spliced in at its new horizon, then folded back into the flat list
  // at the group members' original slots — the ordering move_goal will
  // confirm (it re-indexes exactly this population).
  const handleMoveGoal = (id: string, toHorizon: GoalHorizon, newIndex: number) => {
    setGoals((list) => {
      const dragged = list.find((g) => g.id === id);
      if (!dragged) return list;
      const dest = list.filter(
        (g) => g.horizon === toHorizon && g.status === "active" && !g.hidden && g.id !== id,
      );
      dest.splice(Math.min(newIndex, dest.length), 0, { ...dragged, horizon: toHorizon });
      const destIds = new Set(dest.map((g) => g.id));
      const out: Goal[] = [];
      let di = 0;
      for (const g of list) out.push(destIds.has(g.id) ? dest[di++] : g);
      return out;
    });
    goalsApi.move(id, toHorizon, newIndex).catch((e) => log.error("goal move failed", e));
  };

  const submit = async () => {
    const raw = draft.trim();
    setDraft("");
    if (!raw) return;
    const { text, horizon, projectId, createProjectName } = parseGoalText(raw, projects, { projects: features.goalProjects, timeframes: features.goalTimeframes });
    if (!text) return;
    trace("capture.goal", { ...(horizon ? { horizon } : {}), text: clip(text) });
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
    const { text, horizon, projectId, createProjectName } = parseGoalText(raw, projects, { projects: features.goalProjects, timeframes: features.goalTimeframes });
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

  const renderGoal = (goal: Goal) => (
    <GoalRow
      key={goal.id}
      goal={goal}
      projects={projects}
      focused={focusedId === goal.id}
      editing={editingId === goal.id}
      onEdit={() => setEditingId(goal.id)}
      onCommitEdit={(raw) => handleCommitEdit(goal, raw)}
      onAchieve={() => handleAchieve(goal)}
      onUnachieve={() => handleUnachieve(goal)}
      onDelete={() => handleDelete(goal)}
      onPause={(duration) => handlePause(goal, duration)}
      onResume={() => handleResume(goal)}
      onSetProject={(projectId) => handleSetProject(goal, projectId)}
      onCreateProject={onCreateProject}
    />
  );

  const active = (horizon: GoalHorizon) =>
    goals.filter((g) => g.horizon === horizon && g.status === "active");
  const achieved = goals.filter((g) => g.status === "achieved");

  return (
    <section className="goals section">
      <div
        className="section-head"
        title={features.goalTimeframes ? "Short (months) · Long (years) · Timeless (a direction, never done)" : undefined}
      >
        <span className="section-name">Goals</span>
      </div>

      {/* Always-open capture, line-only like the section inputs — no
          placeholder, the line is the affordance. Tokens color while you
          type (TokenField): $1/$2/$3 picks the horizon, #tag the project.
          In demo mode the empty field rotates example lines teaching that
          grammar (demoExamples). */}
      <div className="capture">
        <TokenField
          kinds={[
            ...(features.goalTimeframes ? (["horizon"] as const) : []),
            ...(features.goalProjects ? (["project"] as const) : []),
          ]}
          value={draft}
          onChange={setDraft}
          demoExamples={demo ? [
            // Gated on the feature that makes each line's tokens real.
            ...(features.goalTimeframes ? ["Read 12 books this year $1"] : []),
            ...(features.goalTimeframes ? ["Run a half marathon $2"] : []),
            ...(features.goalTimeframes ? ["Stay close to the family $3"] : []),
            ...(features.goalProjects ? ["Launch the side project #build"] : []),
            "Ship the portfolio site this month",
          ] : undefined}
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
        <div className="empty">{features.goalTimeframes
          ? "What are you building toward? $1 short · $2 long · $3 timeless."
          : "What are you building toward?"}</div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        {features.goalTimeframes ? (
          HORIZON_GROUPS.map(({ horizon, label }) => (
            <GoalGroup
              key={horizon}
              horizon={horizon}
              label={label}
              goals={active(horizon)}
              dragging={activeDrag !== null}
              renderRow={renderGoal}
            />
          ))
        ) : (
          // Timeframes off: the simple list — every active goal in stored
          // order, no dividers, no drag (the rows' sortable sits disabled).
          goals.filter((g) => g.status === "active").map(renderGoal)
        )}

        {achieved.length > 0 && (
          <div>
            <div className="tier-divider">
              <span className="tier-label">Achieved</span>
            </div>
            {achieved.map(renderGoal)}
          </div>
        )}

        <DragOverlay>
          {activeDrag ? (
            <div className="drag-overlay">
              <span style={{ color: "var(--text-faint)" }}>⠿</span>
              <span className="item-text">{activeDrag.text}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </section>
  );
}

// One horizon group: the label divider when the group has rows — or while a
// drag is live, so an empty destination shows itself — then the rows and the
// drop strip that keeps an empty group reachable (at rest it's just air; it
// grows only under an active drag). Paused rows render in place but sit out
// the sortable set.
function GoalGroup({
  horizon, label, goals, dragging, renderRow,
}: {
  horizon: GoalHorizon;
  label: string;
  goals: Goal[];
  dragging: boolean;
  renderRow: (goal: Goal) => ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `goalzone-${horizon}` });
  return (
    <div>
      {(goals.length > 0 || dragging) && (
        <div className="tier-divider">
          <span className="tier-label">{label}</span>
        </div>
      )}
      <SortableContext
        items={goals.filter((g) => !g.hidden).map((g) => g.id)}
        strategy={verticalListSortingStrategy}
      >
        {goals.map(renderRow)}
      </SortableContext>
      <div
        ref={setNodeRef}
        className={`section-dropzone${dragging ? " drag-active" : ""}${isOver ? " is-over" : ""}`}
      />
    </div>
  );
}

// One goal row. Active, un-paused rows are sortable — the grip becomes a real
// handle; achieved and paused rows keep the slot as a spacer (columns stay
// aligned with the task rows) and sit out the drag, disabled both ways so
// they're never drag targets either.
function GoalRow({
  goal, projects, focused, editing,
  onEdit, onCommitEdit, onAchieve, onUnachieve, onDelete, onPause, onResume, onSetProject, onCreateProject,
}: {
  goal: Goal;
  projects: Project[];
  focused: boolean;
  editing: boolean;
  onEdit: () => void;
  onCommitEdit: (raw: string) => void;
  onAchieve: () => void;
  onUnachieve: () => void;
  onDelete: () => void;
  onPause: (duration: HideDuration) => void;
  onResume: () => void;
  onSetProject: (projectId: string | null) => void;
  onCreateProject: (name: string) => Promise<Project>;
}) {
  const features = useFeatures();
  const achieved = goal.status === "achieved";
  const paused = goal.hidden;
  // Drag rides the timeframes axis: off, the list is one calm flat list —
  // the grip goes back to a spacer (the stored horizon still drives ∞ vs ✓).
  const draggable = !achieved && !paused && features.goalTimeframes;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: goal.id, disabled: !draggable });
  const project = features.goalProjects
    ? projects.find((p) => p.id === goal.projectId) ?? null
    : null;
  // Digit slots, assigned in render order like the task rows — leftmost is
  // 1, a switched-off axis compacts the numbering (no holes; the achieved
  // row's × takes the slot the pause button would have held). Paused rows
  // render only ↺ + ×.
  const slots: Record<string, string> = {};
  {
    let n = 0;
    const next = () => String(++n);
    if (features.goalProjects) slots.project = next();
    if (!achieved && features.goalPause) slots.pause = next();
    slots.delete = next();
  }
  return (
    <div
      ref={setNodeRef}
      data-goal-id={goal.id}
      className={`item goal-row${achieved ? " done" : ""}${paused ? " hidden" : ""}${focused ? " focused" : ""}${isDragging ? " dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onClick={() => { if (!editing) onEdit(); }}
      {...attributes}
    >
      {/* Task rows' leading grip slot, mirrored so the circle and text
          columns line up across both surfaces — and on active rows a real
          drag handle: across groups changes the horizon, within a group
          reorders. */}
      <span
        className="grip"
        {...(draggable ? { ...listeners, title: "Drag" } : {})}
        aria-hidden={draggable ? undefined : true}
      >⠿</span>
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
            achieved ? onUnachieve() : onAchieve();
          }}
          title={paused
            ? "Paused — hover for ↺ resume"
            : achieved ? "Achieved — click to undo" : "Mark achieved"}
          aria-label="Mark achieved"
        />
      )}

      {editing ? (
        <EditInput
          initial={goal.text}
          onCommit={onCommitEdit}
          kinds={[
            ...(features.goalTimeframes ? (["horizon"] as const) : []),
            ...(features.goalProjects ? (["project"] as const) : []),
          ]}
        />
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
                onClick={(e) => { e.stopPropagation(); onResume(); }}
                title="Resume"
                aria-label="Resume goal"
              ><IconUndo /></button>
              <button
                className="item-action danger"
                data-kb="2"
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                title="Delete goal"
                aria-label="Delete goal"
              ><IconX /></button>
            </>
          ) : (
            <>
              {features.goalProjects && (
                <ProjectMenu
                  kb={slots.project}
                  projects={projects}
                  projectId={goal.projectId}
                  onAssign={onSetProject}
                  onCreateProject={onCreateProject}
                />
              )}
              {/* Its own Settings switch (Settings → Goal actions) — an
                  achieved row has nothing to pause, so it keeps just
                  ✓/#/×. */}
              {!achieved && features.goalPause && (
                <HideMenu
                  kb={slots.pause}
                  onHide={onPause}
                  verb="Pause"
                />
              )}
              <button
                className="item-action danger"
                data-kb={slots.delete}
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                title="Delete goal"
                aria-label="Delete goal"
              ><IconX /></button>
            </>
          )}
        </>
      )}
    </div>
  );
}

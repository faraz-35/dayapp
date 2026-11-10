// cards.tsx — the analytics page's small distribution cards: the hero stat,
// one roster card (Projects), and the two segmented-bar cards (Priority,
// Delegation). The numbers arrive via props from the shell's dashboard
// fetch. The split entries double as filter picks: each card receives the
// shell's axis selection and toggle (the same state and handlers the
// FilterBar's menus use — "" is the no-project bucket, 0 the unmarked
// tier), so a click applies that axis to the whole page, the top-right
// pills light up with it, and while a selection stands the card shows it —
// selected entries active, the rest dimmed. Counts are FACET counts (the
// backend drops each card's own axis from its split): selecting a project
// never zeroes its peers — the distribution stays whole, only the other
// axes' scope applies.

/** The pick state one entry renders: selected ("on"), or dimmed ("off")
 * while its axis carries a selection the entry isn't part of. */
function pickState<T>(selected: Set<T>, key: T): "on" | "off" | "" {
  return selected.has(key) ? "on" : selected.size > 0 ? "off" : "";
}

import { useState } from "react";
import { PriorityBars } from "../../components/PriorityBars";
import type { AgentCountsLike } from "./types";
import Chevron from "./Chevron";
import { ProjectCount, TierCount } from "../../types/analytics";

/** The projects card shows this many roster rows until its chevron expands. */
const MAX_PROJECT_ROWS = 10;

/** Priority's segment colors — intensity steps of the one accent, the same
 *  scale language as the calendar (P1 carries the most weight). The alphas
 *  ride --accent-rgb so every theme tints its own accent. */
const TIER_BG: Record<string, string> = {
  "1": "var(--accent)",
  "2": "rgba(var(--accent-rgb), 0.62)",
  "3": "rgba(var(--accent-rgb), 0.36)",
  none: "rgba(var(--accent-rgb), 0.16)",
};

/** One number of the hero card. */
export function StatCard({ value, label, accent }: { value: string | number; label: string; accent?: boolean }) {
  return (
    <div className={`an-stat${accent ? " accent" : ""}`}>
      <span className="v">{value}</span>
      <span className="l">{label}</span>
    </div>
  );
}

/** One label/bar/count row of the projects card — the bar is relative to
 * `max`, so the group reads as proportions at a glance. The row is the
 * project's filter pick (`state` — see pickState). */
function BarRow({
  label,
  title,
  count,
  max,
  state,
  onToggle,
}: {
  label: string;
  title?: string;
  count: number;
  max: number;
  state: "on" | "off" | "";
  onToggle: () => void;
}) {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  return (
    <button
      className={`an-row${state ? ` ${state}` : ""}${count === 0 ? " zero" : ""}`}
      title={title}
      onClick={onToggle}
    >
      <span className="name">{label}</span>
      <span className="track">
        <span className="fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="count">{count}</span>
    </button>
  );
}

/** The projects roster: the backend returns it zero-filled and sorted by
 *  count — the card shows the top ten until the head chevron opens it all. */
export function ProjectsCard({
  projects,
  onToggle,
  selected,
}: {
  projects: ProjectCount[];
  /** Applies one project to the top-right scope ("" = the none bucket). */
  onToggle: (name: string) => void;
  /** The shell's project selection ("" = the none bucket). */
  selected: Set<string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const max = Math.max(1, ...projects.map((p) => p.count));
  const rows = expanded ? projects : projects.slice(0, MAX_PROJECT_ROWS);
  const expandable = projects.length > MAX_PROJECT_ROWS;
  return (
    <section className="an-card an-projects">
      <div className="an-card-title">Projects</div>
      <div className="an-proj-body">
        {rows.map((p) => (
          <BarRow
            key={p.name ?? "__none"}
            label={p.name ?? "none"}
            title={`Filter by ${p.name ?? "no project"}`}
            count={p.count}
            max={max}
            state={pickState(selected, p.name ?? "")}
            onToggle={() => onToggle(p.name ?? "")}
          />
        ))}
        {expandable && !expanded && (
          <>
            {/* The fade + chip ride over the tenth row — the hint that the
                roster continues below the fold. */}
            <span className="an-proj-fade" aria-hidden="true" />
            <button
              className="an-proj-more"
              onClick={() => setExpanded(true)}
              title="Show all projects"
              aria-label="Show all projects"
            >
              <Chevron open />
            </button>
          </>
        )}
        {expandable && expanded && (
          <button
            className="an-proj-less"
            onClick={() => setExpanded(false)}
            title="Show the top ten"
            aria-label="Show the top ten"
          >
            <Chevron className="up" />
          </button>
        )}
      </div>
      {rows.length === 0 && <div className="dash-empty">Nothing in this range.</div>}
    </section>
  );
}

/** The priority card's shape: one segmented bar (tier proportions) plus a
 * glyph legend. Says "which tier you usually clear" in one glance. */
export function PriorityCard({
  tiers,
  max,
  onToggle,
  selected,
}: {
  tiers: TierCount[];
  max: number;
  /** Applies one tier to the top-right scope (0 = the unmarked bucket). */
  onToggle: (tier: number) => void;
  /** The shell's tier selection (0 = the unmarked bucket). */
  selected: Set<number>;
}) {
  const total = tiers.reduce((s, t) => s + t.count, 0);
  return (
    <section className="an-card an-priority">
      <div className="an-card-title">Priority</div>
      <div className="an-segbar">
        {tiers.map((t) => (
          <span
            key={t.tier ?? 0}
            className="seg"
            style={{
              width: total > 0 ? `${(t.count / total) * 100}%` : "0%",
              background: TIER_BG[t.tier == null ? "none" : String(t.tier)],
            }}
          />
        ))}
      </div>
      <div className="an-seg-legend">
        {tiers.map((t) => {
          const state = pickState(selected, t.tier ?? 0);
          return (
            <button
              key={t.tier ?? 0}
              className={`leg${state ? ` ${state}` : ""}${max > 0 && t.count === 0 ? " zero" : ""}`}
              title={`Filter by ${t.tier == null ? "unmarked" : `P${t.tier}`}`}
              onClick={() => onToggle(t.tier ?? 0)}
            >
              <PriorityBars priority={t.tier} />
              {t.count}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** The Agent vs <owner> card: one segmented bar over the delegation axis.
 *  Under a delegation filter the selected side reads active, the other
 *  dimmed — both stay clickable (one side selected = that scope; both =
 *  everyone). */
export function DelegationCard({
  agents,
  ownerLabel,
  onToggle,
  selected,
}: {
  agents: AgentCountsLike;
  ownerLabel: string;
  /** Applies one side to the top-right scope. */
  onToggle: (side: "agent" | "mine") => void;
  /** The shell's delegation selection. */
  selected: Set<"agent" | "mine">;
}) {
  const total = agents.agent + agents.mine;
  return (
    <section className="an-card">
      <div className="an-card-title">Delegation</div>
      <div className="an-segbar">
        <span
          className="seg"
          style={{ width: total > 0 ? `${(agents.agent / total) * 100}%` : "0%", background: TIER_BG["1"] }}
        />
        <span
          className="seg"
          style={{ width: total > 0 ? `${(agents.mine / total) * 100}%` : "0%", background: TIER_BG["3"] }}
        />
      </div>
      <div className="an-seg-legend">
        {(["agent", "mine"] as const).map((side) => {
          const state = pickState(selected, side);
          return (
            <button
              key={side}
              className={`leg${state ? ` ${state}` : ""}`}
              title={`Filter by ${side === "agent" ? "Agent" : ownerLabel}`}
              onClick={() => onToggle(side)}
            >
              {side === "agent" ? "Agent" : ownerLabel} {side === "agent" ? agents.agent : agents.mine}
            </button>
          );
        })}
      </div>
    </section>
  );
}

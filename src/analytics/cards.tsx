// cards.tsx — the analytics page's small distribution cards: the hero stat,
// one roster card (Projects), and the two segmented-bar cards (Priority,
// Delegation). Each is present-only: the numbers arrive via props from the
// shell's dashboard fetch, the scope-filter hide rules stay in the shell
// (they read the filter, which cards never see).

import { useState } from "react";
import { PriorityBars } from "../components/PriorityBars";
import type { AgentCountsLike } from "./types";
import type { ProjectCount, TierCount } from "../lib";
import Chevron from "./Chevron";

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
 *  `max`, so the group reads as proportions at a glance. */
function BarRow({
  label,
  title,
  count,
  max,
}: {
  label: string;
  title?: string;
  count: number;
  max: number;
}) {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  return (
    <div className={`an-row${count === 0 ? " zero" : ""}`} title={title}>
      <span className="name">{label}</span>
      <span className="track">
        <span className="fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="count">{count}</span>
    </div>
  );
}

/** The projects roster: the backend returns it zero-filled and sorted by
 *  count — the card shows the top ten until the head chevron opens it all. */
export function ProjectsCard({ projects }: { projects: ProjectCount[] }) {
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
            title={p.name ?? "no project"}
            count={p.count}
            max={max}
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
 *  glyph legend. Says "which tier you usually clear" in one glance. */
export function PriorityCard({ tiers, max }: { tiers: TierCount[]; max: number }) {
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
        {tiers.map((t) => (
          <span key={t.tier ?? 0} className={`leg${max > 0 && t.count === 0 ? " zero" : ""}`}>
            <PriorityBars priority={t.tier} />
            {t.count}
          </span>
        ))}
      </div>
    </section>
  );
}

/** The Agent vs <owner> card: one segmented bar over the delegation axis.
 *  Hides while the agent axis itself is filtered (a filtered view can't
 *  compare against itself — the shell's split-card rule). */
export function DelegationCard({ agents, ownerLabel }: { agents: AgentCountsLike; ownerLabel: string }) {
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
        <span className="leg">Agent {agents.agent}</span>
        <span className="leg">{ownerLabel} {agents.mine}</span>
      </div>
    </section>
  );
}

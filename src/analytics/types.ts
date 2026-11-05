// types.ts — the analytics folder's shared prop shapes: the pieces of the
// dashboard payload the cards read, and the axis-filter handle the shell
// hands the FilterBar. The full API types live in ../lib beside the fetch
// wrappers; nothing here duplicates them.

/** The delegation split the DelegationCard renders. */
export type AgentCountsLike = { agent: number; mine: number };

/** The axis scope selections, owned by the shell (they feed every fetch);
 *  the FilterBar renders and toggles them through this handle. Projects: ""
 *  is the "no project" bucket; priority 0 is the unmarked tier; a single
 *  delegation side restricts, both sides together are everyone. */
export interface AxisFilterHandle {
  selProjects: Set<string>;
  selTiers: Set<number>;
  selAgent: Set<"agent" | "mine">;
  toggleProject: (name: string) => void;
  toggleTier: (tier: number) => void;
  toggleAgent: (side: "agent" | "mine") => void;
  clear: () => void;
}

// features.tsx — the existence switches, as context. Settings → Features
// owns what the app HAS at all; every component that renders feature chrome
// (menus, badges, bars, parsers' flags) reads the axis here instead of
// threading another prop. App provides the values from its settings-backed
// state; the flags are also in the settings store for the CLI.
import { createContext, useContext } from "react";

export interface Features {
  /** The organising axes — projects are per surface, like the archive below:
   *  a switched-off surface's axis never parses, labels, or filters. */
  taskProjects: boolean;
  noteProjects: boolean;
  goalProjects: boolean;
  /** The goals' $1/$2/$3 horizon tiers — off, goals are one simple list: the
   *  token never parses, the groups and the drag go with it. */
  goalTimeframes: boolean;
  taskPriorities: boolean;
  notePriorities: boolean;
  agent: boolean;
  /** The measurement/action features. */
  timer: boolean;
  reminders: boolean;
  /** Soft-archive (◐) is per surface: tasks, notes, and each of their halves
   *  hide independently — either off leaves the other's buttons, reveal
   *  toggles, and header ◐ fully working. Daily habits pause rather than
   *  hide (same ◐ column, its own switch and reveal). */
  taskHide: boolean;
  dailyPause: boolean;
  noteHide: boolean;
  goalPause: boolean;
  /** Task details (the ⋯ spec body) and the notes' ⬇ .txt export — content
   *  features Faraz can switch off like any other existence toggle. */
  taskDetails: boolean;
  noteDownload: boolean;
  /** The surfaces (already state-backed in App — mirrored here for parsing
   *  flags so one context answers every "does this exist" question). */
  tasks: boolean;
  today: boolean;
  daily: boolean;
  backlog: boolean;
  notes: boolean;
  goals: boolean;
  journal: boolean;
  quotes: boolean;
}

// The factory defaults (a fresh install's store is empty): the plain task
// list + notes, projects on every surface — every power axis off. App's
// sget defaults must stay in sync with these.
export const FeaturesContext = createContext<Features>({
  taskProjects: true, noteProjects: true, goalProjects: true, goalTimeframes: true,
  taskPriorities: false, notePriorities: false, agent: false,
  timer: false, reminders: false,
  taskHide: false, dailyPause: false, noteHide: false, goalPause: true,
  taskDetails: false, noteDownload: true,
  tasks: true, today: true, daily: true, backlog: true,
  notes: true, goals: false, journal: false, quotes: false,
});

export const useFeatures = () => useContext(FeaturesContext);

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

export const FeaturesContext = createContext<Features>({
  taskProjects: true, noteProjects: true, goalProjects: true,
  taskPriorities: true, notePriorities: true, agent: true,
  timer: true, reminders: true,
  taskHide: true, dailyPause: true, noteHide: true, goalPause: true,
  taskDetails: true, noteDownload: true,
  tasks: true, today: true, daily: true, backlog: true,
  notes: true, goals: true, journal: true, quotes: true,
});

export const useFeatures = () => useContext(FeaturesContext);

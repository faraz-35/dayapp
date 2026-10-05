// features.tsx — the existence switches, as context. Settings → Features
// owns what the app HAS at all; every component that renders feature chrome
// (menus, badges, bars, parsers' flags) reads the axis here instead of
// threading another prop. App provides the values from its settings-backed
// state; the flags are also in the settings store for the CLI.
import { createContext, useContext } from "react";

export interface Features {
  /** The organising axes. */
  projects: boolean;
  taskPriorities: boolean;
  notePriorities: boolean;
  agent: boolean;
  /** The measurement/action features. */
  timer: boolean;
  reminders: boolean;
  hide: boolean;
  /** The surfaces (already state-backed in App — mirrored here for parsing
   *  flags so one context answers every "does this exist" question). */
  tasks: boolean;
  notes: boolean;
  goals: boolean;
  journal: boolean;
  quotes: boolean;
}

export const FeaturesContext = createContext<Features>({
  projects: true, taskPriorities: true, notePriorities: true, agent: true,
  timer: true, reminders: true, hide: true,
  tasks: true, notes: true, goals: true, journal: true, quotes: true,
});

export const useFeatures = () => useContext(FeaturesContext);

// The settings vocabulary — the feature keys, the header buttons, the gating
// map, the tab list. Data only, no JSX: the panes and the shell (and App,
// which owns the state these names type) all read one source.

export type FeatureKey =
  | "tasks" | "today" | "daily" | "backlog" | "notes" | "goals" | "journal" | "quotes"
  | "taskProjects" | "noteProjects" | "goalProjects" | "goalTimeframes"
  | "taskPriorities" | "notePriorities" | "agent" | "timer" | "reminders"
  | "taskHide" | "dailyPause" | "noteHide" | "goalPause"
  | "taskDetails" | "noteDownload";

// The header's icon buttons — each an On/Off choice in the Header group.
export type HeaderBtn = "palette" | "hidden" | "analytics" | "journal" | "quotes" | "settings" | "theme";

// The feature area is three surface cards, each carrying its existence master
// on the card title itself — the title-line switch, no separate master row;
// a sub-row dims while its master is off. Journal/Quotes ride the Notes card
// (the ##j/##q capture bus) but never dim: their pages capture on their own,
// so they outlive Notes being off.
export const FEATURE_GROUPS = [
  { id: "tasks", title: "Tasks" },
  { id: "notes", title: "Notes" },
  { id: "goals", title: "Goals" },
] as const;

// The panes, in tab order — Features holds the three surface cards, the
// rest are single cards.
export const TABS = [
  { id: "features", label: "Features" },
  { id: "appearance", label: "Appearance" },
  { id: "header", label: "Header" },
  { id: "views", label: "Views" },
] as const;
export type Tab = (typeof TABS)[number]["id"];

export const FEATURES: { key: FeatureKey; label: string; hint: string; group: (typeof FEATURE_GROUPS)[number]["id"] }[] = [
  { key: "tasks", label: "Tasks", hint: "the whole surface — capture + all three sections", group: "tasks" },
  { key: "today", label: "Today", hint: "section", group: "tasks" },
  { key: "daily", label: "Daily", hint: "section", group: "tasks" },
  { key: "backlog", label: "Backlog", hint: "section", group: "tasks" },
  { key: "timer", label: "Timer", hint: "per-task time tracking (▶ / ⏱)", group: "tasks" },
  { key: "reminders", label: "Reminders", hint: "the ◷ date that pulls a row to Today", group: "tasks" },
  { key: "taskProjects", label: "Task projects", hint: "the #tag axis + the row's label", group: "tasks" },
  { key: "taskHide", label: "Task hide", hint: "soft-archive Today + Backlog rows (◐)", group: "tasks" },
  { key: "dailyPause", label: "Pause daily tasks", hint: "the ◐ pause on Daily habits — auto-resumes at its date", group: "tasks" },
  { key: "taskDetails", label: "Task details", hint: "the ⋯ spec body under a task", group: "tasks" },
  { key: "taskPriorities", label: "Task priorities", hint: "the !1–!3 tiers + signal bars", group: "tasks" },
  { key: "agent", label: "Agent delegation", hint: "the @ axis — 🤖 badge + the agent queue", group: "tasks" },
  { key: "notes", label: "Notes", hint: "the notepad surface", group: "notes" },
  { key: "noteProjects", label: "Note projects", hint: "the #tag footer token + the collapsed label", group: "notes" },
  { key: "notePriorities", label: "Note priorities", hint: "the !N footer tiers on notes", group: "notes" },
  { key: "noteHide", label: "Note hide", hint: "soft-archive notes (◐)", group: "notes" },
  { key: "noteDownload", label: "Note download", hint: "the ⬇ .txt export on notes", group: "notes" },
  { key: "journal", label: "Journal", hint: "##j entries + the page — survives Notes off", group: "notes" },
  { key: "quotes", label: "Quotes", hint: "##q entries, the page + the idle moment — survives Notes off", group: "notes" },
  { key: "goals", label: "Goals", hint: "the identity layer", group: "goals" },
  { key: "goalTimeframes", label: "Goal timeframes", hint: "the $1/$2/$3 tiers — off, goals are one simple list", group: "goals" },
  { key: "goalProjects", label: "Goal projects", hint: "the #tag link on a goal", group: "goals" },
  { key: "goalPause", label: "Goal pause", hint: "set a goal down — the ◐ with an expiry, resumed by ↺", group: "goals" },
];

// Rows whose switch is pointless while their card's master (or a tighter
// gate) is off — the row goes inert and its hint says why. (The Appearance
// header rows ride each entry's `need`; the screensaver's is hard-coded in
// its row.)
export const GATED_BY: Partial<Record<FeatureKey, FeatureKey>> = {
  today: "tasks",
  daily: "tasks",
  backlog: "tasks",
  agent: "tasks",
  timer: "tasks",
  reminders: "tasks",
  taskProjects: "tasks",
  taskHide: "tasks",
  taskDetails: "tasks",
  taskPriorities: "tasks",
  dailyPause: "daily",
  noteProjects: "notes",
  notePriorities: "notes",
  noteHide: "notes",
  noteDownload: "notes",
  goalProjects: "goals",
  goalTimeframes: "goals",
  goalPause: "goals",
};

// `need` lists the features the button reads — the row goes inert only when
// ALL of them are off (the ◐ button works while any archive axis exists).
// Array order is both the card's row order and the header cluster's order.
export const HEADER_BUTTONS: { key: HeaderBtn; label: string; hint: string; need?: FeatureKey[] }[] = [
  { key: "palette", label: "Command palette", hint: "⌘ on macOS, the prompt field elsewhere — the mouse door for ⌘P" },
  { key: "hidden", label: "Hidden entries", hint: "the ◐ archive peek", need: ["taskHide", "dailyPause", "noteHide", "goalPause"] },
  { key: "analytics", label: "Analytics", hint: "the chart icon" },
  { key: "journal", label: "Journal", hint: "the prose icon", need: ["journal"] },
  { key: "quotes", label: "Quotes", hint: "the quote icon", need: ["quotes"] },
  { key: "settings", label: "Settings", hint: "the gear icon" },
  { key: "theme", label: "Theme cycle", hint: "the droplet — walks every theme, subscript = position" },
];

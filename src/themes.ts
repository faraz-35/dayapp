// themes.ts — the theme system. The whole app renders through the CSS
// custom-property ladder in :root (index.css), so a theme is exactly that
// ladder re-valued: applyTheme writes the properties onto <html>, every
// surface re-skins in one paint. No component knows themes exist.
//
// A theme carries the eleven color shades (the same tokens the Settings
// editor exposes). The derived values — the accent's rgb triplet (the CSS
// spells accent alphas as rgba(var(--accent-rgb), a)), the two scrims, and
// the two card shadows — are computed from those eleven: scrims and shadows
// from the background's luminance (a light theme gets lighter, softer
// darks), the triplet from the accent hex. Derived, never stored — a custom
// theme is eleven colors and nothing else.
//
// Built-ins: Dark (the original ladder, verbatim) and Light (the full white
// reskin). Custom themes live in the settings store (settings.json — the
// same file the CLI's theme verbs read and write); the active id in
// dayapp-theme. App-level, like zoom — one set across demo/real.

export interface ThemeColors {
  bg: string;
  bgElev: string;
  bgSoft: string;
  bgHover: string;
  border: string;
  text: string;
  textDim: string;
  textFaint: string;
  accent: string;
  done: string;
  danger: string;
}

export interface Theme {
  id: string;
  name: string;
  colors: ThemeColors;
}

export const DARK: Theme = {
  id: "dark",
  name: "Dark",
  colors: {
    bg: "#0e0f11",
    bgElev: "#16181c",
    bgSoft: "#121417",
    bgHover: "#1c1f24",
    border: "#30343c",
    text: "#d2d5da",
    textDim: "#a2a7b1",
    textFaint: "#7b7f88",
    accent: "#7b8cff",
    done: "#3a3f48",
    danger: "#e5484d",
  },
};

export const LIGHT: Theme = {
  id: "light",
  name: "Light",
  colors: {
    bg: "#f7f7f8",
    bgElev: "#ffffff",
    bgSoft: "#f0f0f2",
    bgHover: "#e9e9ed",
    border: "#d9dade",
    text: "#212327",
    textDim: "#5d6167",
    textFaint: "#90949b",
    accent: "#5061f5",
    done: "#b3b7bf",
    danger: "#d7383f",
  },
};

// Editor order — the Settings form renders the shades in ladder order.
export const COLOR_FIELDS: { key: keyof ThemeColors; label: string }[] = [
  { key: "bg", label: "Background" },
  { key: "bgElev", label: "Elevated" },
  { key: "bgSoft", label: "Soft fill" },
  { key: "bgHover", label: "Hover" },
  { key: "border", label: "Lines" },
  { key: "text", label: "Text" },
  { key: "textDim", label: "Secondary" },
  { key: "textFaint", label: "Faint" },
  { key: "accent", label: "Accent" },
  { key: "done", label: "Crossed" },
  { key: "danger", label: "Danger" },
];

// ---- Persistence ----------------------------------------------------------
//
// The custom list is store-backed: App reads it through sget at mount and
// writes through sset on create/delete — the CLI's --theme-* verbs hit the
// same key, so both writers see one list.

export function resolveTheme(id: string, custom: Theme[]): Theme {
  return [...BUILT_IN_THEMES, ...custom].find((t) => t.id === id) ?? DARK;
}

export const BUILT_IN_THEMES: Theme[] = [DARK, LIGHT];

// ---- Application ----------------------------------------------------------

// Relative luminance (WCAG). Only used as a light/dark read — the scrims and
// shadows just need to know which side of the divide they're on.
function luminance(hex: string): number {
  const m = hex.replace("#", "");
  const full = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const [r, g, b] = [0, 2, 4].map((i) =>
    parseInt(full.slice(i, i + 2), 16) / 255,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function accentRgb(hex: string): string {
  const m = hex.replace("#", "");
  const full = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  return [0, 2, 4]
    .map((i) => parseInt(full.slice(i, i + 2), 16))
    .join(", ");
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement.style;
  const c = theme.colors;
  root.setProperty("--bg", c.bg);
  root.setProperty("--bg-elev", c.bgElev);
  root.setProperty("--bg-soft", c.bgSoft);
  root.setProperty("--bg-hover", c.bgHover);
  root.setProperty("--border", c.border);
  root.setProperty("--text", c.text);
  root.setProperty("--text-dim", c.textDim);
  root.setProperty("--text-faint", c.textFaint);
  root.setProperty("--accent", c.accent);
  root.setProperty("--accent-rgb", accentRgb(c.accent));
  root.setProperty("--done", c.done);
  root.setProperty("--danger", c.danger);
  // Derived: light themes dim with lighter, softer darks (a 0.65 black scrim
  // over white reads as a void, not a pause).
  const light = luminance(c.bg) > 0.5;
  root.setProperty("--scrim", light ? "rgba(20, 20, 26, 0.22)" : "rgba(0, 0, 0, 0.4)");
  root.setProperty("--scrim-strong", light ? "rgba(20, 20, 26, 0.38)" : "rgba(0, 0, 0, 0.65)");
  root.setProperty("--track", light ? "rgba(0, 0, 0, 0.06)" : "rgba(255, 255, 255, 0.05)");
  root.setProperty("--shadow-md", light
    ? "0 8px 24px rgba(20, 20, 30, 0.12)"
    : "0 8px 24px rgba(0, 0, 0, 0.5)");
  root.setProperty("--shadow-lg", light
    ? "0 16px 48px rgba(20, 20, 30, 0.18)"
    : "0 16px 48px rgba(0, 0, 0, 0.6)");
  // Native widgets follow: color wells, the date input, scrollbars.
  root.colorScheme = light ? "light" : "dark";
}

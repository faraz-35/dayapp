// The project color axis. The mode (Settings → Appearance → Project colors)
// is module state set once at App init (the settings cache is populated
// before first render) and on the setting's own toggle; an external settings
// write reloads the webview, so it can't go stale. MobileView exits before
// App mounts, so the phone always reads multi.

// multi — a hue per project id — or single, one quiet grey for every label
// and dot.
let singleColorProjects = false;
export const setProjectColorMode = (single: boolean): void => {
  singleColorProjects = single;
};

/** The color for a project's label/dot: a deterministic, well-spaced hue per
 *  id (hash the id → hue; fixed S/L tuned for legibility on the dark bg), or
 *  the metadata grey when the color axis is switched off. */
export const projectColor = (id: string): string => {
  if (singleColorProjects) return "var(--text-dim)";
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 65% 68%)`;
};

// icons.tsx — the app's ONE action-icon family, carried over from the header
// buttons' language (the ones that read right): 16-box viewBox, stroked
// currentColor at 1.7, round caps and joins, drawn at 14px. Every button
// glyph in the app renders from here — row actions, note actions, the theme
// cycle — so weight, size, and corner rounding can never drift apart again
// (the unicode ◷/◐/×/▶/↺/#/✎ rode font metrics and each sat a size off its
// neighbors). Filled shapes (dots, the half-moon's dark half, the play head)
// are the exception and say so inline.
//
// Not here: the analytics card-nav chevrons (a smaller card chrome family)
// and the agent badge (identity metadata, not an action).

const base = {
  viewBox: "0 0 16 16",
  width: 14,
  height: 14,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function IconChevron({ up = false }: { up?: boolean }) {
  return (
    <svg {...base}>
      <path d={up ? "M4.6 9.8 8 6.4l3.4 3.4" : "M4.6 6.2 8 9.6l3.4-3.4"} />
    </svg>
  );
}

export function IconArrowUp() {
  return (
    <svg {...base}>
      <path d="M8 12.4V3.6M4.4 7.2 8 3.6l3.6 3.6" />
    </svg>
  );
}

export function IconClock() {
  return (
    <svg {...base}>
      <circle cx="8" cy="8" r="5" />
      <path d="M8 5v3l2.2 1.4" />
    </svg>
  );
}

export function IconHalfMoon() {
  return (
    <svg {...base}>
      <circle cx="8" cy="8" r="5" />
      {/* the dark half, filled */}
      <path d="M8 3a5 5 0 0 1 0 10Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconDownload() {
  return (
    <svg {...base}>
      <path d="M8 2.8v6.4M5 6.5 8 9.5l3-3M3.4 12.8h9.2" />
    </svg>
  );
}

export function IconX() {
  return (
    <svg {...base}>
      <path d="m4.6 4.6 6.8 6.8M11.4 4.6l-6.8 6.8" />
    </svg>
  );
}

export function IconUndo() {
  return (
    <svg {...base}>
      <path d="M2.6 8a5.4 5.4 0 1 0 5.4-5.4 5.9 5.9 0 0 0-4.1 1.7L2.6 5.6" />
      <path d="M2.6 2.4v3.2h3.2" />
    </svg>
  );
}

export function IconPlay() {
  return (
    <svg {...base}>
      <path d="M5.8 3.6v8.8L12.4 8Z" />
    </svg>
  );
}

export function IconPause() {
  return (
    <svg {...base}>
      <path d="M5.7 3.8v8.4M10.3 3.8v8.4" />
    </svg>
  );
}

export function IconHash() {
  return (
    <svg {...base}>
      <path d="M5.9 2.9 4.7 13.1M11.3 2.9l-1.2 10.2M3.3 6.3h10M2.7 9.7h10" />
    </svg>
  );
}

export function IconDots() {
  return (
    <svg {...base} stroke="none">
      {/* three filled dots */}
      {[3.9, 8, 12.1].map((cx) => (
        <circle key={cx} cx={cx} cy="8" r="1.15" fill="currentColor" />
      ))}
    </svg>
  );
}

export function IconPencil() {
  return (
    <svg {...base}>
      <path d="M9.7 3.3l3 3L6 13H3v-3l6.7-6.7ZM8.4 4.6l3 3" />
    </svg>
  );
}

export function IconMoon() {
  return (
    <svg {...base}>
      <path d="M13.2 9.3A5.6 5.6 0 1 1 6.7 2.8a4.4 4.4 0 0 0 6.5 6.5Z" />
    </svg>
  );
}

export function IconSun() {
  return (
    <svg {...base}>
      <circle cx="8" cy="8" r="2.7" />
      <path d="M8 1.7v1.8M8 12.5v1.8M1.7 8h1.8M12.5 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M12.4 3.6l-1.3 1.3M4.9 11.1l-1.3 1.3" />
    </svg>
  );
}

// The custom-theme mark: a swatch card with three color dots — "a theme",
// not dark or light in particular. The header pairs it with the position
// subscript (.theme-idx).
export function IconThemes() {
  return (
    <svg {...base}>
      <rect x="2.4" y="3.4" width="11.2" height="9.2" rx="2" />
      <circle cx="5.3" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="10.7" cy="8" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Chevron.tsx — the analytics surfaces' one chevron glyph, rotated per use
// (never two mismatched unicode glyphs riding the font baseline). `className`
// carries the variants: `.left` = a back arrow, `.down`/`.up` = a dropdown
// trigger, `.open` = an expanded state. Styling lives under `.dd-chev` in
// index.css.

export default function Chevron({ open = false, className = "" }: { open?: boolean; className?: string }) {
  return (
    <svg
      className={`dd-chev${open ? " open" : ""}${className ? ` ${className}` : ""}`}
      width="10"
      height="10"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path
        d="M4 2.8 8.2 6 4 9.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

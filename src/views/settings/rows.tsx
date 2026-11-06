// The settings rows — the four primitives every pane builds from. Same
// language across the page: a row is label over hint with a control at the
// right, dimming inert while its gate is off.

export function ToggleRow({
  label, hint, on, needs, needsLabel, onToggle,
}: {
  label: string;
  hint: string;
  on: boolean;
  needs?: boolean;      // true while the gate feature is off
  needsLabel?: string;  // the gate feature's name, for the hint
  onToggle: () => void;
}) {
  return (
    <div
      className={`set-row${needs ? " dep" : ""}`}
      role="switch"
      aria-checked={on}
      aria-disabled={needs || undefined}
      onClick={needs ? undefined : onToggle}
    >
      <span className="set-row-text">
        <span className="set-name">{label}</span>
        <span className="set-hint">
          {needs ? `needs ${needsLabel} — off above` : hint}
        </span>
      </span>
      <span className={`set-sw${on ? " on" : ""}`} />
    </div>
  );
}

/** A plain row: label over hint, anything at the right (a Seg, a swatch).
 *  Same `needs` dimming as the switch rows — inert while the gate is off. */
export function InfoRow({ label, hint, needs, needsLabel, children }: {
  label: string;
  hint: string;
  needs?: boolean;
  needsLabel?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={`set-row${needs ? " dep" : ""}`} aria-disabled={needs || undefined}>
      <span className="set-row-text">
        <span className="set-name">{label}</span>
        <span className="set-hint">
          {needs ? `needs ${needsLabel} — off above` : hint}
        </span>
      </span>
      {children}
    </div>
  );
}

/** Segmented control — exclusive choices in one hairline box. */
export function Seg({ value, options, onPick }: {
  value: string;
  options: { v: string; label: string }[];
  onPick: (v: string) => void;
}) {
  return (
    <span className="set-seg" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.v}
          role="radio"
          aria-checked={o.v === value}
          className={o.v === value ? "on" : ""}
          onClick={(e) => { e.stopPropagation(); onPick(o.v); }}
        >{o.label}</button>
      ))}
    </span>
  );
}

/** Group: a card — the analytics card language — under its uppercase title.
 *  A surface card passes `master`: its existence switch rides the title line
 *  itself — the whole line is the click target, the box is the state — and
 *  no separate master row renders beneath. */
export function Group({ title, count, master, children }: {
  title: string;
  count?: string;
  master?: { on: boolean; hint: string; onToggle: () => void };
  children: React.ReactNode;
}) {
  return (
    <section className="an-card">
      <div
        className={`an-card-title${master ? " toggable" : ""}`}
        role={master ? "switch" : undefined}
        aria-checked={master?.on}
        title={master?.hint}
        onClick={master?.onToggle}
      >
        {title}
        {count && <span className="set-count">{count}</span>}
        {master && <span className={`set-sw${master.on ? " on" : ""}`} />}
      </div>
      {children}
    </section>
  );
}

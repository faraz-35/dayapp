// The tier's signal bars: filled count = urgency (P1 = 3 filled, P3 = 1), so
// the most urgent tier carries the most visual mass. Own module so every
// surface that speaks the bar language — item rows, the Backlog/notes tier
// dividers, the analytics legend, and the capture fields' token display —
// imports the same component without coupling to the row (ItemRow imports
// TokenField, which renders these bars too).

export function PriorityBars({ priority }: { priority: 1 | 2 | 3 | null }) {
  const filled = priority == null ? 0 : 4 - priority;
  return (
    <span
      className="priority-bars"
      title={priority == null ? undefined : `Priority ${priority}`}
      aria-label={priority == null ? undefined : `Priority ${priority}`}
    >
      {[0, 1, 2].map((i) => (
        <span key={i} className={`bar${i < filled ? " filled" : ""}`} />
      ))}
    </span>
  );
}

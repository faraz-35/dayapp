// NamePrompt — the "What's your name?" card. The first-run ask (the app opens
// on a clean, empty db) and the ⌘P → Set Your Name… door share it. A floating
// surface like the palette, not inline chrome: it floats over the list, asks,
// and leaves. Enter saves (trimmed; empty = the neutral "Live @ DayApp"),
// Esc closes — on first run the parent treats close as "skipped", stored so
// the ask never repeats.
import { useEffect, useRef, useState } from "react";

export default function NamePrompt({
  initial, onSave, onClose,
}: {
  initial: string;
  onSave: (name: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <div className="name-backdrop">
      <div className="name-card">
        <div className="name-label">What's your name?</div>
        <input
          ref={ref}
          className="name-input"
          value={value}
          placeholder="Your name"
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSave(value);
            else if (e.key === "Escape") onClose();
          }}
        />
        <div className="name-hint">
          Enter to save · Esc to skip — the header reads “Live @ {value.trim() || "DayApp"}”
        </div>
      </div>
    </div>
  );
}

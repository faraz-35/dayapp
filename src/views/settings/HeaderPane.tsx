// HeaderPane — which icon buttons mount top-right. Off hides only the button;
// the view stays in ⌘P (the two-layers rule). The last row is the window's
// own native bar — the OS close/minimize/zoom chrome, independent of the
// in-app buttons.

import { trace } from "../../logging/devlog";
import { FEATURES, HEADER_BUTTONS, type FeatureKey, type HeaderBtn } from "./vocab";
import { Group, ToggleRow } from "./rows";

export default function HeaderPane({
  features, headerBtns, onToggleHeaderBtn, windowDecorations, onToggleWindowDecorations,
}: {
  features: Record<FeatureKey, boolean>;
  headerBtns: Record<HeaderBtn, boolean>;
  onToggleHeaderBtn: (btn: HeaderBtn) => void;
  windowDecorations: boolean;
  onToggleWindowDecorations: (on: boolean) => void;
}) {
  return (
    <Group
      title="Header"
      count={`${HEADER_BUTTONS.filter((b) => headerBtns[b.key]).length} of ${HEADER_BUTTONS.length} shown`}
    >
      <div className="set-rows">
        {HEADER_BUTTONS.map(({ key, label, hint, need }) => (
          <ToggleRow
            key={key}
            label={label}
            hint={hint}
            on={headerBtns[key]}
            needs={need && need.every((k) => !features[k]) ? true : undefined}
            needsLabel={need ? need.map((k) => FEATURES.find((f) => f.key === k)?.label).join(" or ") : undefined}
            onToggle={() => {
              trace("toggle.header", { btn: key, to: !headerBtns[key] });
              onToggleHeaderBtn(key);
            }}
          />
        ))}
        <ToggleRow
          label="Window title bar"
          hint="the native bar — close, minimize, zoom"
          on={windowDecorations}
          onToggle={() => {
            trace("toggle.windowDecorations", { to: !windowDecorations });
            onToggleWindowDecorations(!windowDecorations);
          }}
        />
      </div>
    </Group>
  );
}

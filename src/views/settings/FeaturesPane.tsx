// FeaturesPane — the Tasks / Notes / Goals surface cards side by side (the
// grid stacks below 760px), each carrying its existence master as the card
// title's own switch with the sub-features beneath. The Notes card also
// carries the quote screensaver's idle wait — the Quotes feature's knob.
// Journal/Quotes ride the Notes card but never dim: their pages capture on
// their own, so they outlive Notes being off.

import { trace } from "../../logging/devlog";
import { FEATURES, FEATURE_GROUPS, GATED_BY, type FeatureKey } from "./vocab";
import { Group, InfoRow, Seg, ToggleRow } from "./rows";

export default function FeaturesPane({
  features, onToggleFeature, screensaverMins, onSetScreensaverMins,
}: {
  features: Record<FeatureKey, boolean>;
  onToggleFeature: (key: FeatureKey) => void;
  screensaverMins: number;
  onSetScreensaverMins: (mins: number) => void;
}) {
  const toggle = (key: FeatureKey) => {
    trace("toggle.feature", { feature: key, to: !features[key] });
    onToggleFeature(key);
  };

  return (
    <div className="set-grid3">
      {FEATURE_GROUPS.map((g) => {
        // The master (key === group id) rides the title line; the rows beneath
        // are the sub-features only. The master stays in FEATURES as the
        // label+hint vocabulary the gating hints quote.
        const rows = FEATURES.filter((f) => f.group === g.id && f.key !== g.id);
        const master = FEATURES.find((f) => f.key === g.id)!;
        return (
          <Group
            key={g.id}
            title={g.title}
            master={{
              on: features[g.id],
              hint: master.hint,
              onToggle: () => toggle(g.id),
            }}
          >
            <div className="set-rows">
              {rows.map(({ key, label, hint }) => {
                const gate = GATED_BY[key];
                return (
                  <ToggleRow
                    key={key}
                    label={label}
                    hint={hint}
                    on={features[key]}
                    needs={gate && !features[gate] ? true : undefined}
                    needsLabel={gate ? FEATURES.find((f) => f.key === gate)?.label : undefined}
                    onToggle={() => toggle(key)}
                  />
                );
              })}
              {/* The screensaver is the Quotes feature's knob, so it rides the
                  Notes card right under the Quotes row — inert while Quotes is
                  off, like every sub-row under its master. */}
              {g.id === "notes" && (
                <InfoRow
                  label="Quote screensaver"
                  hint={`${screensaverMins} min idle before a quote appears`}
                  needs={!features.quotes}
                  needsLabel="Quotes"
                >
                  <Seg
                    value={String(screensaverMins)}
                    options={[1, 2, 5, 10].map((m) => ({ v: String(m), label: `${m}m` }))}
                    onPick={(v) => { trace("ui.screensaver", { mins: Number(v) }); onSetScreensaverMins(Number(v)); }}
                  />
                </InfoRow>
              )}
            </div>
          </Group>
        );
      })}
    </div>
  );
}

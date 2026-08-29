// TokenField — a capture field that colors the typed-token grammar (##j/##q
// routes, #tag projects, !N priority, @ agent) while you type. Inputs can't
// style substrings, so the field's real text renders transparent and a mirror
// div underneath paints the same text with the token spans colored — the note
// find-bar's mirror technique (Notes.tsx), applied to every capture surface.
//
// The spans come from scanTokens (lib.ts), the same matcher the capture
// parsers strip with, so what colors is exactly what processes at Enter. A
// line the surface wouldn't parse — an @ in the notes bar, a #tag in the
// Journal capture — stays plain: the color never lies.
//
// The grammar's route prefill rides here too: `nj`/`nq` focus the notes
// capture (focusNav.focusCapture) and dispatch ROUTE_EVENT on it; a TokenField
// with `route` set swaps the leading ##j/##q token. Typing the address IS
// typing the token.

import { useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { projectColor, resolveProjectByName, scanTokens, type Project, type TokenKind } from "./lib";
import { ROUTE_EVENT } from "./focusNav";

type FieldElement = HTMLInputElement | HTMLTextAreaElement;

export default function TokenField({
  kinds,
  capture,
  value,
  onChange,
  onKeyDown,
  multiline = false,
  route = false,
  projects,
  rows,
}: {
  /** The surface's grammar — exactly the tokens its Enter handler parses. */
  kinds: readonly TokenKind[];
  /** data-capture key: the focus grammar's target (nn/nt/nd/nb, nj/nq). */
  capture?: string;
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: ReactKeyboardEvent<FieldElement>) => void;
  /** The notes capture is a multi-line field (Shift+Enter drafts) — the mirror
   *  wraps like a textarea instead of clipping like a single-line input. */
  multiline?: boolean;
  /** Listen for the grammar's route prefill (nj/nq) — the notes bar. */
  route?: boolean;
  /** Colors #tag spans with the resolved project's hue; an unknown name hashes
   *  its own — provisional color for a project the tag is about to create. */
  projects?: Project[];
  rows?: number;
}) {
  const fieldRef = useRef<FieldElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);

  // The field scrolls its content when the line outgrows it (and the notes
  // textarea scrolls vertically past its rows) — the mirror follows, or the
  // colors drift off their glyphs.
  const syncScroll = () => {
    const f = fieldRef.current;
    const m = mirrorRef.current;
    if (f && m) {
      m.scrollTop = f.scrollTop;
      m.scrollLeft = f.scrollLeft;
    }
  };
  useEffect(() => {
    requestAnimationFrame(syncScroll);
  }, [value]);

  // The route prefill: replace any leading route token with the requested one
  // (`nq` on a ##j draft re-routes it) and land the caret at the end.
  useEffect(() => {
    const el = fieldRef.current;
    if (!el || !route) return;
    const onRoute = (e: Event) => {
      const token = (e as CustomEvent<string>).detail;
      onChange(`${token} ${value.replace(/^##[jq]\s*/, "")}`);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    };
    el.addEventListener(ROUTE_EVENT, onRoute);
    return () => el.removeEventListener(ROUTE_EVENT, onRoute);
  }, [route, value, onChange]);

  // The mirror's children: the text split at token boundaries, each token a
  // span in its kind's color (projects in their resolved hue). A trailing
  // newline gets a zero-width tail so the mirror keeps the empty last line the
  // multiline field still reserves (the note-mirror rule).
  const mirrorNodes = useMemo(() => {
    const spans = scanTokens(value, kinds);
    const parts: ReactNode[] = [];
    let pos = 0;
    spans.forEach((s, i) => {
      if (s.start > pos) parts.push(value.slice(pos, s.start));
      parts.push(
        <span
          key={i}
          className={`tok-${s.kind}`}
          style={s.kind === "project" ? { color: hueForTag(s.value, projects) } : undefined}
        >
          {value.slice(s.start, s.end)}
        </span>,
      );
      pos = s.end;
    });
    parts.push(value.slice(pos) + (multiline && value.endsWith("\n") ? "\u200b" : ""));
    return parts;
  }, [value, kinds, projects, multiline]);

  const attach = (el: FieldElement | null) => {
    fieldRef.current = el;
  };
  const shared = {
    "data-capture": capture,
    value,
    spellCheck: false as const,
    onChange: (e: { target: FieldElement }) => onChange(e.target.value),
    onKeyDown,
    onScroll: syncScroll,
  };

  return (
    <div className={`token-field${multiline ? " multiline" : ""}`}>
      <div ref={mirrorRef} className="token-mirror" aria-hidden="true">{mirrorNodes}</div>
      {multiline ? (
        <textarea {...shared} ref={attach} rows={rows} />
      ) : (
        <input {...shared} ref={attach} />
      )}
    </div>
  );
}

// A #tag's hue: its project's own when the name resolves under the item-tag
// rules (the label the row will wear), else a hash of the name — provisional
// color for a project the tag is about to create.
const hueForTag = (name: string, projects?: Project[]): string => {
  const p = projects ? resolveProjectByName(name, projects) : null;
  return projectColor(p ? p.id : name);
};

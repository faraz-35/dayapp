// TokenField — a capture/edit field that colors the typed-token grammar
// (##j/##q routes, #tag projects, !N priority, @ agent) while you type.
// Inputs can't style substrings, so the field's real text renders transparent
// and a mirror div underneath paints the same text with the token spans
// colored — the note find-bar's mirror technique (Notes.tsx), applied to every
// capture surface and the inline edits. Every token family shares the one
// accent: a token reads as "this processes", and only the real content stays
// plain text.
//
// The spans come from scanTokens (lib.ts), the same matcher the capture
// parsers strip with, so what colors is exactly what processes at Enter. A
// line the surface wouldn't parse — an @ in the notes bar, a #tag in the
// Journal capture — stays plain: the color never lies.
//
// The grammar's route prefill rides here too: `nj`/`nq` focus the notes
// capture and `nt`/`nd`/`nb` the task capture (focusNav.focusCapture), each
// dispatching ROUTE_EVENT on its field; a TokenField with `route` set swaps
// the leading route token. Typing the address IS typing the token.

import { useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type Ref } from "react";
import { scanTokens, type TokenKind } from "./lib";
import { ROUTE_EVENT } from "./focusNav";

type FieldElement = HTMLInputElement | HTMLTextAreaElement;

export default function TokenField({
  kinds,
  capture,
  value,
  onChange,
  onKeyDown,
  onBlur,
  onClick,
  className,
  multiline = false,
  route = false,
  rows,
  ref,
}: {
  /** The surface's grammar — exactly the tokens its Enter handler parses. */
  kinds: readonly TokenKind[];
  /** data-capture key: the focus grammar's target (nn/nt/nd/nb, nj/nq). */
  capture?: string;
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: ReactKeyboardEvent<FieldElement>) => void;
  onBlur?: () => void;
  onClick?: (e: ReactMouseEvent<FieldElement>) => void;
  /** Lands on the wrapper — the box to style when the field is an inline
   *  edit (`.item-edit` mode: wrapper carries the box, field goes bare). */
  className?: string;
  /** The notes capture is a multi-line field (Shift+Enter drafts) — the mirror
   *  wraps like a textarea instead of clipping like a single-line input. */
  multiline?: boolean;
  /** Listen for the grammar's route prefill (nj/nq, nt/nd/nb). */
  route?: boolean;
  rows?: number;
  /** The field element itself, for focus/caret control by the owning surface
   *  (EditInput's autofocus-at-end). */
  ref?: Ref<FieldElement>;
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
  // (`nq` on a ##j draft re-routes the note; `nd` on a ##t draft re-routes the
  // task) and land the caret at the end.
  useEffect(() => {
    const el = fieldRef.current;
    if (!el || !route) return;
    const onRoute = (e: Event) => {
      const token = (e as CustomEvent<string>).detail;
      onChange(`${token} ${value.replace(/^##[tjdqb]\s*/, "")}`);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    };
    el.addEventListener(ROUTE_EVENT, onRoute);
    return () => el.removeEventListener(ROUTE_EVENT, onRoute);
  }, [route, value, onChange]);

  // The mirror's children: the text split at token boundaries, each token a
  // span in the shared accent (`.tok` in index.css). A trailing newline gets
  // a zero-width tail so the mirror keeps the empty last line the multiline
  // field still reserves (the note-mirror rule).
  const mirrorNodes = useMemo(() => {
    const spans = scanTokens(value, kinds);
    const parts: ReactNode[] = [];
    let pos = 0;
    spans.forEach((s, i) => {
      if (s.start > pos) parts.push(value.slice(pos, s.start));
      parts.push(<span key={i} className="tok">{value.slice(s.start, s.end)}</span>);
      pos = s.end;
    });
    parts.push(value.slice(pos) + (multiline && value.endsWith("\n") ? "\u200b" : ""));
    return parts;
  }, [value, kinds, multiline]);

  // Owns fieldRef and forwards the caller's ref (React 19 ref-as-prop), so an
  // owning surface like EditInput can focus and place the caret.
  const attach = (el: FieldElement | null) => {
    fieldRef.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) (ref as { current: FieldElement | null }).current = el;
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
    <div className={["token-field", className, multiline ? "multiline" : ""].filter(Boolean).join(" ")}>
      <div ref={mirrorRef} className="token-mirror" aria-hidden="true">{mirrorNodes}</div>
      {multiline ? (
        <textarea {...shared} ref={attach} rows={rows} onBlur={onBlur} onClick={onClick} />
      ) : (
        <input {...shared} ref={attach} onBlur={onBlur} onClick={onClick} />
      )}
    </div>
  );
}

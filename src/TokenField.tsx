// TokenField — a capture/edit field that colors the typed-token grammar
// (##j/##q routes, #tag projects, !N priority, @ agent) while you type — and
// renders each token as what it MEANS: the mirror converts the sigil to its
// display form (##q → quote, !2 → the priority bars, @ → agent; tokenDisplay
// in lib.ts owns the vocabulary). Inputs can't style substrings, so the
// field's real text renders transparent and a mirror div underneath paints
// the same text with the token spans styled — the note find-bar's mirror
// technique (Notes.tsx), applied to every capture surface and the inline
// edits. Every token family shares the one accent: a token reads as "this
// processes", and only the real content stays plain text.
//
// The spans come from scanTokens (lib.ts), the same matcher the capture
// parsers strip with, so what colors is exactly what processes at Enter. A
// line the surface wouldn't parse — an @ in the notes bar, a #tag in the
// Journal capture — stays plain: the color never lies.
//
// Substitution changes the line's metrics (the word is wider than the sigil),
// so the field hides its native caret — it tracks the RAW text and would
// drift off the visible words — and draws its own caret and selection over
// the SUBSTITUTED layout, measured with Range rects over the mirror's own
// text nodes (wrap- and scroll-exact for the multiline captures too). The
// value itself is never rewritten: display only, and the parsers still strip
// the raw tokens.
//
// The grammar's route prefill rides here too: `nj`/`nq` focus the notes
// capture and `nt`/`nd`/`nb` the task capture (focusNav.focusCapture), each
// dispatching ROUTE_EVENT on its field; a TokenField with `route` set swaps
// the leading route token. Typing the address IS typing the token.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type Ref } from "react";
import { scanTokens, tokenDisplay, type TokenKind } from "./lib";
import { PriorityBars } from "./components/PriorityBars";
import { ROUTE_EVENT } from "./focusNav";

type FieldElement = HTMLInputElement | HTMLTextAreaElement;

// One mirror run: the real span it stands for, where its display text starts,
// how long that text is, and whether it's a substituted token (whose display
// length differs from the raw span's — the caret maps to the label's edges
// rather than through it). Concatenated dl's must equal the mirror's text
// content length; the caret locates indices over the actual DOM nodes.
interface Seg { r0: number; r1: number; d0: number; dl: number; sub: boolean }

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
  const caretRef = useRef<HTMLSpanElement>(null);
  const selRectsRef = useRef<HTMLSpanElement>(null);
  const [focused, setFocused] = useState(false);
  // The field's selection in RAW value coordinates — the input is the source
  // of truth; the overlay renders it in display coordinates.
  const [sel, setSel] = useState({ start: 0, end: 0 });

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
    requestAnimationFrame(() => {
      syncScroll();
      readSel();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // The mirror's model: the display parts (raw runs + converted tokens) built
  // in one pass with the real↔display index map. The priority bars render as
  // the row-identical markup (zero display text); the word forms render as
  // accent text; #tag has no display form and colors verbatim.
  const kindKey = kinds.join("+");
  const model = useMemo(() => {
    const spans = scanTokens(value, kinds);
    const parts: ReactNode[] = [];
    const segs: Seg[] = [];
    let dLen = 0;
    let pos = 0;
    const push = (node: ReactNode, text: string, r0: number, r1: number, sub = false) => {
      segs.push({ r0, r1, d0: dLen, dl: text.length, sub });
      dLen += text.length;
      parts.push(node);
    };
    spans.forEach((s, i) => {
      if (s.start > pos) {
        const raw = value.slice(pos, s.start);
        push(raw, raw, pos, s.start);
      }
      const raw = value.slice(s.start, s.end);
      const disp = tokenDisplay(s);
      if (disp === null) {
        push(<span key={i} className="tok">{raw}</span>, raw, s.start, s.end);
      } else if (s.kind === "priority") {
        const tier = s.value === "0" ? null : (Number(s.value) as 1 | 2 | 3);
        push(
          <span key={i} className="tok"><PriorityBars priority={tier} /></span>,
          "",
          s.start,
          s.end,
          true,
        );
      } else {
        push(<span key={i} className="tok tok-word">{disp}</span>, disp, s.start, s.end, true);
      }
      pos = s.end;
    });
    // A trailing newline gets a zero-width tail so the mirror keeps the empty
    // last line the multiline field still reserves (the note-mirror rule).
    const tail = value.slice(pos) + (multiline && value.endsWith("\n") ? "\u200b" : "");
    push(tail, tail, pos, value.length);
    return { parts, segs };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, kindKey, multiline]);

  // Raw index → display index. A caret inside a substituted token sits on one
  // of the label's two edges (whichever half of the sigil it's in), so ← from
  // past the token walks around the word in one step.
  const realToDisplay = (r: number): number => {
    for (const s of model.segs) {
      if (r < s.r0) return s.d0;
      if (r <= s.r1) {
        if (!s.sub || r === s.r0) return s.d0 + (r - s.r0);
        return r - s.r0 < (s.r1 - s.r0) / 2 ? s.d0 : s.d0 + s.dl;
      }
    }
    const last = model.segs[model.segs.length - 1];
    return last.d0 + last.dl;
  };

  // Track the field's selection: selectionchange (document-level, WebKit)
  // covers arrows, drag-select and typing; keyup/mouseup/input are the belt
  // to that suspenders. Reads are DEFERRED to the next animation frame: a
  // synchronous setState from inside the input/selectionchange dispatch
  // re-renders BEFORE React's onChange has read the field, the controlled
  // value reverts to the stale draft, and every keystroke dies (WKWebView
  // fires selectionchange during typing — Chrome doesn't, which is why only
  // the app froze). rAF lands after the whole event batch has committed.
  const readSel = () => {
    const el = fieldRef.current;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    setSel((p) => (p.start === start && p.end === end ? p : { start, end }));
  };
  const rafRef = useRef(0);
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);
  const scheduleReadSel = () => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      readSel();
    });
  };
  useEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    const onDocSel = () => {
      if (document.activeElement === el) scheduleReadSel();
    };
    const onFocus = () => { setFocused(true); scheduleReadSel(); };
    const onBlur = () => { setFocused(false); scheduleReadSel(); };
    document.addEventListener("selectionchange", onDocSel);
    el.addEventListener("keyup", scheduleReadSel);
    el.addEventListener("mouseup", scheduleReadSel);
    el.addEventListener("input", scheduleReadSel);
    el.addEventListener("focus", onFocus);
    el.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("selectionchange", onDocSel);
      el.removeEventListener("keyup", scheduleReadSel);
      el.removeEventListener("mouseup", scheduleReadSel);
      el.removeEventListener("input", scheduleReadSel);
      el.removeEventListener("focus", onFocus);
      el.removeEventListener("blur", onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Paint the caret + selection over the substituted layout. Runs after the
  // mirror commits (rects need its nodes); coordinates are converted to the
  // mirror's content space and the overlays live inside it, so they ride the
  // scroll sync for free.
  useLayoutEffect(() => {
    const mirror = mirrorRef.current;
    if (!mirror) return;
    const box = mirror.getBoundingClientRect();
    const cs = getComputedStyle(mirror);
    // A display index → (text node, offset), walking the mirror's own text
    // nodes — the concatenated dl's equal their lengths, so the walk IS the
    // map. Priority-bars markup carries no text node and is stepped over,
    // exactly like the index math treats it.
    const point = (index: number): { node: Text; offset: number } | null => {
      const walker = document.createTreeWalker(mirror, NodeFilter.SHOW_TEXT);
      let acc = 0;
      let n: Node | null;
      while ((n = walker.nextNode())) {
        const t = n as Text;
        if (index <= acc + t.length) return { node: t, offset: index - acc };
        acc += t.length;
      }
      return null;
    };
    const toContent = (r: DOMRect) => ({
      x: r.left - box.left + mirror.scrollLeft,
      y: r.top - box.top + mirror.scrollTop,
    });
    // A collapsed (or any) range's viewport rect at one text position.
    const rangeRect = (p: { node: Text; offset: number }): DOMRect | null => {
      const rg = document.createRange();
      rg.setStart(p.node, p.offset);
      rg.setEnd(p.node, p.offset);
      return rg.getBoundingClientRect();
    };

    // The caret: only while focused and collapsed (a selection has no caret).
    const caret = caretRef.current;
    if (caret) {
      const showCaret = focused && sel.start === sel.end;
      if (!showCaret) {
        caret.style.display = "none";
      } else {
        const p = point(realToDisplay(sel.end));
        caret.style.display = "block";
        const r = p ? rangeRect(p) : null;
        if (r && !(r.left === 0 && r.top === 0 && r.width === 0 && r.height === 0)) {
          const c = toContent(r);
          caret.style.transform = `translate(${c.x}px, ${c.y}px)`;
          caret.style.height = `${r.height || parseFloat(cs.lineHeight) || 18}px`;
        } else {
          // Empty mirror (or a rect WebKit declined to build) — park the
          // caret at the content origin.
          caret.style.transform = `translate(${parseFloat(cs.paddingLeft) || 0}px, ${parseFloat(cs.paddingTop) || 0}px)`;
          caret.style.height = `${parseFloat(cs.lineHeight) || 18}px`;
        }
      }
    }

    // The selection: one translucent rect per wrapped line (the same accent
    // the native selection used to paint, now over the display layout).
    const selEl = selRectsRef.current;
    if (selEl) {
      selEl.replaceChildren();
      if (sel.end > sel.start) {
        const a = point(realToDisplay(sel.start));
        const b = point(realToDisplay(sel.end));
        if (a && b) {
          const rg = document.createRange();
          rg.setStart(a.node, a.offset);
          rg.setEnd(b.node, b.offset);
          for (const r of rg.getClientRects()) {
            if (r.width < 1) continue;
            const c = toContent(r);
            const rect = document.createElement("i");
            rect.className = "tok-sel-rect";
            rect.style.transform = `translate(${c.x}px, ${c.y}px)`;
            rect.style.width = `${r.width}px`;
            rect.style.height = `${r.height}px`;
            selEl.appendChild(rect);
          }
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, sel, focused]);

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
      <div ref={mirrorRef} className="token-mirror" aria-hidden="true">
        <span ref={selRectsRef} className="tok-sel" />
        <span ref={caretRef} className="tok-caret" />
        {model.parts}
      </div>
      {multiline ? (
        <textarea {...shared} ref={attach} rows={rows} onBlur={onBlur} onClick={onClick} />
      ) : (
        <input {...shared} ref={attach} onBlur={onBlur} onClick={onClick} />
      )}
    </div>
  );
}

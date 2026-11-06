// The typed-token grammar — ONE matcher for every typed token (`##j`/`##q`
// routes, `#tag` projects, `!N` priority, `@` agent, `$N` horizon), shared by
// the capture parsers and the capture fields' syntax coloring (TokenField).
// Single source on purpose: what colors as a token while you type is exactly
// what processes at Enter — the two can never drift apart.

import type { Section } from "../types/item";
import type { Project } from "../types/project";
import type { EntryKind } from "../types/entry";
import { GOAL_HORIZONS, type GoalHorizon } from "../types/goal";
import type { TokenAxes, TokenKind, TokenSpan } from "../types/token";

// A sigil token: the sigil at a word boundary (start of text or after one
// whitespace char — so "foo#bar" and "wow!!" stay literal), then its payload.
const PROJECT_RE = /(?:^|\s)#([\w-]+)/g;
const PRIORITY_RE = /(?:^|\s)!([0-3])(?=\s|$)/g;
const AGENT_RE = /(?:^|\s)@([01]?)(?=\s|$)/g;
// The goals' horizon: $1 short · $2 long · $3 timeless, word-boundary-guarded
// like !N so "$100k" and "costs $3b" stay literal money.
const HORIZON_RE = /(?:^|\s)\$([123])(?=\s|$)/g;
// The notes-bus route: a leading ##j/##q only (lookahead, so the token itself
// is exactly the three chars and the text after it starts at a boundary).
const ENTRY_RE = /^##([jq])(?=\s|$)/;
// The task-capture route: a leading ##t/##d/##b picks the destination section.
// Unlike the entry route it doesn't own the line — the rest keeps parsing the
// item grammar, so it colors AND strips independently of what follows.
const SECTION_RE = /^##([tdb])(?=\s|$)/;
// The notes' project-clear twin of !0 — stripped ahead of parseProjectTag so a
// project literally named "0" can never resolve.
const NOTE_CLEAR_RE = /(?:^|\s)#0(?=\s|$)/g;

interface SigilSpan {
  start: number;
  end: number;
  value: string;
}

// Every match of a sigil regex, spans covering just the token. `^` only
// matches at index 0, so any other match began with its one boundary space.
function matchSigil(text: string, re: RegExp): SigilSpan[] {
  const out: SigilSpan[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({
      start: m.index + (m.index === 0 ? 0 : 1),
      end: m.index + m[0].length,
      value: m[1] ?? "",
    });
  }
  return out;
}

/** Slice every span out and normalise whitespace. The empty-result guard (the
 *  "input is never lost" rule) belongs to callers. */
function stripSpans(text: string, spans: SigilSpan[]): string {
  let out = "";
  let pos = 0;
  for (const s of spans) {
    out += text.slice(pos, s.start);
    pos = s.end;
  }
  out += text.slice(pos);
  return out.replace(/\s+/g, " ").trim();
}

const resolveAxes = (axes?: TokenAxes) => ({
  projects: axes?.projects !== false,
  priorities: axes?.priorities !== false,
  agent: axes?.agent !== false,
});

// ---- Scanner --------------------------------------------------------------

/** Every token in the line, for the capture fields' syntax coloring. `kinds`
 *  picks the surface's grammar — the task capture carries `@`, the notes bar
 *  doesn't, and each bus routes its own leading token: the notes bar's ##j/##q
 *  owns the WHOLE line (past it everything is verbatim content — no other
 *  token processes there, so none colors there either), while the task
 *  capture's ##t/##d/##b only picks the destination, so the line's item
 *  grammar keeps scanning past it. A line a surface wouldn't parse stays
 *  plain: the color never lies. */
export function scanTokens(text: string, kinds: readonly TokenKind[]): TokenSpan[] {
  // "entry" carries both routes; the granular pair lets a surface carry one
  // without the other (Settings → Features can switch Journal/Quotes off) —
  // a route whose kind isn't listed stays plain. The color never lies.
  if (kinds.includes("entry") || kinds.includes("entry-journal") || kinds.includes("entry-quote")) {
    const m = text.match(ENTRY_RE);
    const ok = m && (
      kinds.includes("entry") ||
      (m[1] === "j" ? kinds.includes("entry-journal") : kinds.includes("entry-quote"))
    );
    if (ok && m) return [{ kind: "entry", start: 0, end: m[0].length, value: m[1] }];
  }
  const out: TokenSpan[] = [];
  if (kinds.includes("section") || kinds.includes("section-today")
      || kinds.includes("section-daily") || kinds.includes("section-backlog")) {
    const m = text.match(SECTION_RE);
    if (m) {
      const ok = kinds.includes("section")
        || (m[1] === "t" ? kinds.includes("section-today")
          : m[1] === "d" ? kinds.includes("section-daily")
          : kinds.includes("section-backlog"));
      if (ok) out.push({ kind: "section", start: 0, end: m[0].length, value: m[1] });
    }
  }
  const sigils: Array<[TokenKind, RegExp]> = [
    ["project", PROJECT_RE],
    ["priority", PRIORITY_RE],
    ["agent", AGENT_RE],
    ["horizon", HORIZON_RE],
  ];
  for (const [kind, re] of sigils) {
    if (!kinds.includes(kind)) continue;
    for (const s of matchSigil(text, re)) out.push({ kind, ...s });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The display form a token renders as while it colors (TokenField's mirror):
 *  the sigil converts to what it means — ##j→journal, ##q→quote, ##t→today,
 *  ##d→daily, ##b→backlog, any @-token→agent, and !0..3→the priority bars
 *  (PriorityBars markup; !0 the empty track). Null = renders verbatim —
 *  `#tag` carries an arbitrary name, nothing to convert. The EMPTY string is
 *  the bars' case: the symbol is pure CSS markup occupying no text, which
 *  keeps the mirror's text metrics honest (the caret overlay's index math
 *  treats the token as zero display characters, and the caret jumps the
 *  symbol in one step). Same single source as the coloring: a token converts
 *  exactly when its surface parses it. */
export function tokenDisplay(span: { kind: TokenKind; value: string }): string | null {
  switch (span.kind) {
    case "entry":
      return span.value === "j" ? "journal" : "quote";
    case "section":
      return span.value === "t" ? "today" : span.value === "d" ? "daily" : "backlog";
    case "priority":
      return "";
    case "agent":
      return "agent";
    case "horizon":
      return span.value === "1" ? "short" : span.value === "2" ? "long" : "timeless";
    default:
      return null;
  }
}

/** The advance width of `text` in the app's base 13px text style, measured
 *  through a throwaway canvas. Used where a substituted token must occupy its
 *  raw sigil's exact width because the surface keeps its NATIVE caret (the
 *  note body's bars) — a display-only field draws its own caret and needs no
 *  such matching. */
export function baseTextWidth(text: string): number {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return 0;
  ctx.font = '13px -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", system-ui, sans-serif';
  return ctx.measureText(text).width;
}

// ---- Item parsers -----------------------------------------------------------

/** Extract & strip the delegation tokens: a standalone `@` (assign to the AI
 *  agent) or `@0` (clear the assignment), both at word boundaries. `@1` also
 *  assigns, mirroring the `!N` shape. Like the priority parser, a bare token
 *  that would empty the row keeps the text intact so the input is never lost —
 *  the assignment still applies. */
function parseAgentToken(text: string): { text: string; agent: boolean | null } {
  const spans = matchSigil(text, AGENT_RE);
  if (spans.length === 0) return { text, agent: null };
  const stripped = stripSpans(text, spans);
  return { text: stripped || text.trim(), agent: spans[spans.length - 1].value !== "0" };
}

/** Extract & strip `!0..3` tokens (word-boundary `!` + digit, so "wow!!" and
 *  "foo!bar" stay literal). The last token's level wins; 0 is the explicit
 *  clear. Like stripTag, a bare token that would empty the row keeps the text
 *  intact so the input is never lost — the priority still applies. */
function parsePriorityTag(text: string): { text: string; priority: 0 | 1 | 2 | 3 | null } {
  const spans = matchSigil(text, PRIORITY_RE);
  if (spans.length === 0) return { text, priority: null };
  const stripped = stripSpans(text, spans);
  return {
    text: stripped || text.trim(),
    priority: Number(spans[spans.length - 1].value) as 0 | 1 | 2 | 3,
  };
}

/**
 * Detect a `#tag` in item text and resolve it to a Project — so typing
 * "fix bug #day" links the item to the "dayapp" project without opening the #
 * popover. This is an input shortcut for the existing Projects axis, *not* a
 * separate tag entity (see AGENTS.md "What NOT to add"). Callers go through
 * `parseItemTags`, which also handles `!N` priority tokens.
 *
 * Two passes, in order:
 *  1. **Existing match** — case-insensitive exact name win, else a *unique*
 *     name prefix (so "#day" → "dayapp" only if no other project starts with
 *     "day"). The first resolvable tag wins; an item carries a single project.
 *  2. **Create** — if *no* tag matched an existing project, the LAST tag may
 *     create a brand-new project — but only when it ends the text with nothing
 *     after it (e.g. "fix bug #acme" bootstraps an "acme" project; "fix bug
 *     #acme notes" does not). A bare "#acme" that would empty the row keeps the
 *     text intact so the input is never lost.
 *
 * Whichever path wins, the winning tag is stripped from the returned text.
 * `createProjectName` is mutually exclusive with `projectId`; callers create
 * the project and assign it. When nothing resolved, `projectId` is null and
 * callers decide whether that means "no project" (on create) or "leave the
 * existing assignment alone" (on edit).
 */
export function parseProjectTag(
  text: string,
  projects: Project[],
): { text: string; projectId: string | null; createProjectName?: string } {
  // A tag is `#` at a word boundary (start or after whitespace) followed by
  // word chars / hyphens — so "foo#bar" mid-word is not treated as a tag.
  const tags = matchSigil(text, PROJECT_RE);

  // 1) Existing project: first resolvable tag wins. Strip it from the text.
  for (const t of tags) {
    const project = resolveProjectByName(t.value, projects);
    if (project) return stripTag(text, t, project.id);
  }

  // 2) No existing match: create a project from the last tag, but only when it
  //    sits at the very end of the text (nothing but whitespace after it).
  if (tags.length > 0) {
    const last = tags[tags.length - 1];
    if (text.slice(last.end).trim() === "") {
      return { ...stripTag(text, last, null), createProjectName: last.value };
    }
  }

  return { text, projectId: null };
}

/** Slice the tag out of `text` and normalise whitespace. Only strip when
 *  something readable remains — a bare "#day" shouldn't produce an empty row;
 *  in that case the tag is kept visible so the input is never lost. */
function stripTag(
  text: string,
  span: SigilSpan,
  projectId: string | null,
): { text: string; projectId: string | null } {
  const cleaned = text.slice(0, span.start) + text.slice(span.end);
  const normalized = cleaned.replace(/\s+/g, " ").trim();
  return { text: normalized || text.trim(), projectId };
}

/** Exact (case-insensitive) name match wins; otherwise a unique prefix match.
 *  No match, or an ambiguous prefix (≥2 projects), resolves to null. */
function resolveProjectByName(tag: string, projects: Project[]): Project | null {
  const lower = tag.toLowerCase();
  const exact = projects.find((p) => p.name.toLowerCase() === lower);
  if (exact) return exact;
  const prefixes = projects.filter((p) => p.name.toLowerCase().startsWith(lower));
  return prefixes.length === 1 ? prefixes[0] : null;
}

/** The combined capture/edit text parser: resolves `#tag` → Project, `!1..3` →
 *  priority, and a bare `@` → agent assignment, stripping all three from the
 *  returned text. The token kinds are independent and composable in any order
 *  ("fix bug #acme !2 @", "fix bug @ !2 #acme", or any alone) — agent and
 *  priority tokens are stripped first so a trailing `#tag` still satisfies the
 *  project-create rule on the remaining text. When nothing resolves, the
 *  fields are null/false-side and callers decide whether that means "not set"
 *  (on create) or "leave the existing value alone" (on edit).
 *
 *  See `parseProjectTag` for the project resolution rules; the priority rule
 *  is: any `!0..3` at a word boundary, the LAST one wins, all are stripped
 *  (`!0` means "clear", only meaningful on edit). The agent rule is the same
 *  shape: a standalone `@` assigns, `@0` is the explicit clear, `@word` stays
 *  literal (so "ping @bob" is never eaten); last token wins.
 */
export function parseItemTags(
  text: string,
  projects: Project[],
  axes?: TokenAxes,
): { text: string; projectId: string | null; createProjectName?: string; priority: 0 | 1 | 2 | 3 | null; agent: boolean | null } {
  const a = resolveAxes(axes);
  const noAgent = a.agent ? parseAgentToken(text) : { text, agent: null };
  const unPrio = a.priorities ? parsePriorityTag(noAgent.text) : { text: noAgent.text, priority: null as 0 | 1 | 2 | 3 | null };
  if (!a.projects) return { text: unPrio.text, projectId: null, priority: unPrio.priority, agent: noAgent.agent };
  const project = parseProjectTag(unPrio.text, projects);
  return { ...project, priority: unPrio.priority, agent: noAgent.agent };
}

/** The goals capture/edit parser: a `$1/$2/$3` horizon token ($1 short ·
 *  $2 long · $3 timeless) picks the tier and is stripped — anywhere in the
 *  line, the item-grammar way, last one winning — then the normal `#tag`
 *  project rules apply to the remainder ("better entrepreneur $2 #hustle" →
 *  long horizon, "better entrepreneur", hustle project). Word-boundary
 *  guarded like !N, so money ("$100k", "costs $3b") stays literal. A bare
 *  token that would empty the row keeps the text intact so the input is
 *  never lost (the !N rule). `horizon` is null when no token was present;
 *  callers decide whether that means "short" (on create) or "leave the tier
 *  alone" (on edit), mirroring parseItemTags. */
export function parseGoalText(
  text: string,
  projects: Project[],
  axes?: TokenAxes,
): { text: string; horizon: GoalHorizon | null; projectId: string | null; createProjectName?: string } {
  const allowProject = axes?.projects !== false;
  const allowTimeframe = axes?.timeframes !== false;
  const spans = allowTimeframe ? matchSigil(text, HORIZON_RE) : [];
  const horizon: GoalHorizon | null = spans.length
    ? GOAL_HORIZONS[Number(spans[spans.length - 1].value) - 1] as GoalHorizon
    : null;
  const body = spans.length ? (stripSpans(text, spans) || text.trim()) : text.trim();
  if (!allowProject) return { text: body, horizon, projectId: null };
  const project = parseProjectTag(body, projects);
  return { horizon, ...project };
}

// ---- Note tokens ------------------------------------------------------------
//
// Notes set priority/project with the same token grammar as tasks, generalized
// to multi-line bodies: in the CAPTURE field the tokens sit inline (exactly
// item capture, `@` excepted — notes have no delegation axis and `@word` stays
// literal), and in an existing note you type them on their own final line
// after a blank line ("after all the content"). Tokens are input syntax only —
// caught at capture/blur into the columns, never stored or rendered. No token
// leaves the current values alone (like task edits); `!0` clears the priority
// and `#0` clears the project (tasks' `!0` rule plus its project twin — notes
// have no popover to clear through).

/** The pending footer's position: the last non-empty line, only when a blank
 *  line separates it from the prose above (splitNoteFooter's shape). `start`/
 *  `end` span the raw line in `body`; `proseEnd` is where the body ends once
 *  the footer and its blank line are dropped. Null when there's no candidate
 *  — nothing above, or the line sits first. */
function footerLine(body: string): { start: number; end: number; proseEnd: number } | null {
  const lines = body.split("\n");
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) { last = i; break; }
  }
  if (last <= 0 || lines[last - 1].trim()) return null;
  let start = 0;
  for (let i = 0; i < last; i++) start += lines[i].length + 1;
  return { start, end: start + lines[last].length, proseEnd: start - lines[last - 1].length - 1 };
}

/** One footer word's kind, by the strict shapes splitNoteFooter accepts:
 *  `!0..3` priority, `#word` project (`#0` included — it processes as the
 *  clear). Anything else is prose and makes the line just text. */
function footerTokenKind(word: string): TokenKind | null {
  if (/^![0-3]$/.test(word)) return "priority";
  if (/^#[\w-]+$/.test(word)) return "project";
  return null;
}

/** The note body's live coloring: the token spans a pending footer line would
 *  color with while it's still being typed — the blur-catch's twin, so what
 *  colors is exactly what the catch will strip and apply. Empty when the last
 *  line isn't a catchable footer (prose on the line, no blank line above, or
 *  nothing to catch) — and inline tokens elsewhere in the body never color,
 *  because they never process there. */
export function scanNoteFooterTokens(body: string, axes?: TokenAxes): TokenSpan[] {
  const allowProject = axes?.projects !== false;
  const allowPriority = axes?.priorities !== false;
  const f = footerLine(body);
  if (!f) return [];
  const line = body.slice(f.start, f.end);
  const out: TokenSpan[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const kind = footerTokenKind(m[0]);
    if (kind === "project" && !allowProject) return []; // a # line is just prose
    if (kind === "priority" && !allowPriority) return []; // so is an ! line
    if (kind === null) return [];
    out.push({
      kind,
      start: f.start + m.index,
      end: f.start + m.index + m[0].length,
      value: m[0],
    });
  }
  return out;
}

/** Split a body's trailing token line: the last non-empty line, when a blank
 *  line separates it from the prose above and it holds ONLY `!0..3` / `#tag`
 *  tokens. Returns the body without it plus the parsed values — `body` is what
 *  renders/previews/exports; the token fields are what the blur-catch applies.
 *  With no valid footer, `body` is the input unchanged and both fields are
 *  null. Strict shape: any prose on the line makes it just text, so a
 *  markdown-ish "# Heading" or a stray "wow!!" never parses. */
export function splitNoteFooter(
  body: string,
  /** Off, `#tag`/`#0` are not footer tokens — a line carrying one is body
   *  text, never stripped. Same for `!N` when the priority axis is off. */
  axes?: TokenAxes,
): {
  body: string;
  /** 0 = the explicit `!0` clear; null = no priority token on the line. */
  priority: 0 | 1 | 2 | 3 | null;
  tag: string | null;
  /** A `#0` token — the explicit project clear. */
  clearProject: boolean;
} {
  const allowProject = axes?.projects !== false;
  const allowPriority = axes?.priorities !== false;
  const f = footerLine(body);
  if (f) {
    let priority: 0 | 1 | 2 | 3 | null = null;
    let tag: string | null = null;
    let clearProject = false;
    let ok = true;
    for (const tok of body.slice(f.start, f.end).trim().split(/\s+/)) {
      if (/^![0-3]$/.test(tok)) {
        if (!allowPriority) { ok = false; break; }                          // ! is prose here
        priority = Number(tok[1]) as 0 | 1 | 2 | 3;                         // last wins
      }
      else if (/^#/.test(tok) && !allowProject) { ok = false; break; }      // # is prose here
      else if (tok === "#0") clearProject = true;
      else if (/^#[\w-]+$/.test(tok)) tag = tok.slice(1);                   // last wins
      else { ok = false; break; }
    }
    if (ok && (priority !== null || tag !== null || clearProject)) {
      return { body: body.slice(0, f.proseEnd).trimEnd(), priority, tag, clearProject };
    }
  }
  return { body, priority: null, tag: null, clearProject: false };
}

/** The note capture parser — items' grammar minus the delegation axis: `!0..3`
 *  and `#tag` resolve and strip from the line exactly like task capture
 *  (anywhere in the line, last wins, unmatched trailing tag creates), but a
 *  bare `@` / `@word` stays literal. A `#0` (project clear) is stripped and
 *  ignored — a fresh note has nothing to clear, like `!0` at task capture. */
export function parseNoteCapture(
  text: string,
  projects: Project[],
  axes?: TokenAxes,
): { text: string; priority: 0 | 1 | 2 | 3 | null; projectId: string | null; createProjectName?: string } {
  const a = resolveAxes(axes);
  // Strip standalone `#0` tokens first so parseProjectTag can't resolve or
  // create a project literally named "0".
  const noClear = a.projects ? stripNoteClearTags(text) : text;
  const unPrio = a.priorities ? parsePriorityTag(noClear) : { text: noClear, priority: null as 0 | 1 | 2 | 3 | null };
  if (!a.projects) return { text: unPrio.text, priority: unPrio.priority, projectId: null };
  const project = parseProjectTag(unPrio.text, projects);
  return { ...project, priority: unPrio.priority };
}

function stripNoteClearTags(text: string): string {
  const spans = matchSigil(text, NOTE_CLEAR_RE);
  if (spans.length === 0) return text;
  return stripSpans(text, spans) || text.trim();
}

/** Resolve a footer/capture `#tag` for notes: the item-tag semantics as a
 *  plain lookup — case-insensitive exact name, else a unique prefix, else
 *  create (the caller creates through App's handleCreateProject so the
 *  projects state stays the single source). */
export function resolveNoteTag(
  tag: string,
  projects: Project[],
): { projectId: string | null; createProjectName?: string } {
  const p = resolveProjectByName(tag, projects);
  return p ? { projectId: p.id } : { projectId: null, createProjectName: tag };
}

// ---- Route tokens (##j / ##q / ##t / ##d / ##b) ------------------------------
//
// The typed-capture routers: a LEADING `##x` token in a capture turns the line
// into a different kind of content. The notes bar routes it to a different
// TABLE (journal entry / quote — stored and displayed differently); the task
// capture routes it to a different SECTION of the same table (Today / Daily /
// Backlog — the one capture that replaced the three per-section inputs). Both
// share the reserved `##` prefix, which can't collide with the `#tag` project
// token (a lone `#` never starts a tag word, so `#heading` prose is safe too).
// Leading position only — mid-line `##x` is prose. Entry text is stored
// verbatim past the token; task text keeps its item grammar (`#tag`/`!N`/`@`
// compose after the route). Routes are capture-only: editing an existing
// thing never re-routes it (notes stopped that build by decision; tasks move
// by drag or the ↑ button).

/** Parse a capture line's leading `##j`/`##q` route. Null when the line isn't
 *  routed (a normal note); `{ kind, text }` with the token stripped otherwise —
 *  `text` may be empty (a bare token), which the caller treats as a no-op
 *  rather than creating an empty entry. */
export function parseEntryCapture(text: string): { kind: EntryKind; text: string } | null {
  const m = text.match(ENTRY_RE);
  if (!m) return null;
  return { kind: m[1] === "j" ? "journal" : "quote", text: text.slice(m[0].length).trim() };
}

/** Parse the task capture's leading `##t`/`##d`/`##b` route into a section,
 *  stripped from the text. No token = Today — the default working destination.
 *  A bare token with no text is the caller's no-op (no junk row), same rule as
 *  the entry routes. */
export function parseTaskCapture(
  text: string,
  /** Which destination sections exist (Settings → Features). A route to a
   *  switched-off section degrades to the default (Today), token stripped —
   *  the same degrade-not-die rule the entry routes follow. */
  routes: { today: boolean; daily: boolean; backlog: boolean } = { today: true, daily: true, backlog: true },
): { section: Section; text: string } {
  const m = text.match(SECTION_RE);
  if (!m) return { section: "today", text };
  const section = m[1] === "t" ? "today" : m[1] === "d" ? "daily" : "backlog";
  return {
    section: routes[section] ? section : "today",
    text: text.slice(m[0].length).trim(),
  };
}

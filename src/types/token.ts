// The typed-token grammar's vocabulary: what a token IS. The matcher and the
// parsers live together in lib/tokens.ts — the single source on purpose: what
// colors as a token while you type is exactly what processes at Enter.

export type TokenKind = "entry" | "entry-journal" | "entry-quote" | "section" | "section-today" | "section-daily" | "section-backlog" | "project" | "priority" | "agent" | "horizon";

/** A matched token. `start`/`end` span the sigil through the token's last
 *  char (the word-boundary space before it stays plain text); `value` is the
 *  captured payload — the route letter, project name, digit, or "" for a
 *  bare `@`. */
export interface TokenSpan {
  kind: TokenKind;
  start: number;
  end: number;
  value: string;
}

/** Which token axes a surface's grammar carries — ON by default; a false
 *  axis never parses: its sigils stay literal prose and nothing resolves,
 *  creates, or strips. Mirrors the TokenField `kinds` list so what colors is
 *  exactly what processes (the single-source invariant), driven from
 *  Settings → Features. */
export interface TokenAxes {
  projects?: boolean;
  priorities?: boolean;
  agent?: boolean;
  timeframes?: boolean;
}

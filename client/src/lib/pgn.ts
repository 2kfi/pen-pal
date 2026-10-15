/**
 * PGN export (plan step 26).
 *
 * The eighth thing step 26 asked for, and the one that was quietly missing:
 * resign, draw, take-back, a move list and board persistence all existed, so a
 * game could be played between two people and both could reload and see it, but
 * there was no way to get the game out of the app. A correspondence you cannot
 * keep is a correspondence you can only read where you wrote it.
 *
 * ## Why this can be built at all
 *
 * The server stores ciphertext, so it cannot export a move list, and it should
 * not be able to. Everything needed to write a PGN is in the sealed envelope the
 * client already opens: SAN per move, ply order, who was white, how it ended.
 * The export happens here, in the browser, from data the user has already
 * decrypted in order to look at the board.
 *
 * ## The SAN problem
 *
 * `toSAN` in the rules engine deliberately carries no `+` or `#`, because the
 * engine cannot know what came before the move without replaying. PGN has no
 * such luxury: `Qh5#` and `Qh5` are different games to any reader, and to every
 * program that loads the file. So the suffixes are recovered here by replaying,
 * which is the same thing ChessBoard does to draw its move list.
 */

import {
  cloneState,
  gameResult,
  inCheck,
  initialState,
  legalMoves,
  makeMove,
  type GameState,
} from './chessEngine';
import { uciOf, type GameSession, type SealedMove } from './chessGames';

/** The undo-stack type is not exported from the rules engine. */
type Stack = Parameters<typeof makeMove>[2];

export interface PgnNames {
  white: string;
  black: string;
}

const UNKNOWN_DATE = '????.??.??';

/** `2026.10.15`, which is what PGN wants, not ISO 8601. */
function pgnDate(iso: string | null | undefined, fallback: string): string {
  const day = iso ? iso.slice(0, 10) : fallback;
  const [y, m, d] = day.split('-');
  return y && m && d ? `${y}.${m}.${d}` : day.replace(/-/g, '.') || UNKNOWN_DATE;
}

/** A quote inside a tag value would close it early. */
const clean = (value: string): string => value.replace(/["\\]/g, "'");

/**
 * The result tag.
 *
 * A resignation and a checkmate are both wins, and a PGN that records them
 * identically is still a true PGN: the header has no vocabulary for *how* a game
 * ended, only for who won.
 */
export function pgnResult(
  session: Pick<GameSession, 'status' | 'winnerId' | 'whiteId' | 'blackId'>,
): string {
  switch (session.status) {
    case 'checkmate':
    case 'resigned':
    case 'timeout':
      if (session.winnerId === null) return '1/2-1/2';
      return session.winnerId === session.whiteId ? '1-0' : '0-1';
    case 'stalemate':
    case 'draw':
      return '1/2-1/2';
    default:
      return '*';
  }
}

/**
 * Movetext, with check and mate suffixes recovered by replay.
 *
 * Returns `null` for the text when the record will not replay, because emitting
 * a PGN that no program can load is worse than emitting none: the failure would
 * surface in some chess program, months later, with nobody left who could
 * explain it.
 */
export function pgnMovetext(moves: SealedMove[]): { text: string | null; final: GameState | null } {
  const replay = initialState();
  const history: Stack = [];
  const tokens: string[] = [];

  for (const sealed of moves) {
    const found = legalMoves(replay).find((m) => uciOf(m) === sealed.uci);
    if (!found) return { text: null, final: null };

    makeMove(replay, found, history);

    const after = cloneState(replay);
    const verdict = gameResult(after);
    let san = sealed.san;
    if (verdict === 'checkmate') san += '#';
    else if (verdict === 'playing' && inCheck(after, after.turn)) san += '+';

    // PGN numbers only WHITE's moves. Numbering every ply produces
    // "1. f3 2. e5 3. g4", which is not a legal movetext: a reader counting the
    // moves would get a game twice as long as the one that was played.
    tokens.push(`${sealed.ply % 2 === 1 ? `${(sealed.ply + 1) / 2}. ` : ''}${san}`);
  }

  return { text: tokens.join(' '), final: replay };
}

/**
 * Wrapped to 80 columns, which is the PGN convention and the reason every file
 * in a PGN archive looks the same.
 */
export function wrapMovetext(text: string, width = 80, indent = ''): string {
  if (!text) return '';
  const lines: string[] = [];
  let line = indent;
  for (const token of text.split(' ').filter(Boolean)) {
    if (line.length > indent.length && line.length + 1 + token.length > width) {
      lines.push(line);
      line = indent + token;
    } else {
      line = line.length === indent.length ? indent + token : `${line} ${token}`;
    }
  }
  if (line.trim()) lines.push(line);
  return lines.join('\n');
}

/**
 * A complete PGN for a game this pair played.
 *
 * `site` is left to the caller because it is the one tag with real privacy
 * content: a self-hosted instance's address says who runs it, so a default here
 * would quietly publish something.
 */
export function toPgn(
  session: Pick<GameSession, 'status' | 'winnerId' | 'whiteId' | 'blackId'> &
    Partial<Pick<GameSession, 'createdAt'>>,
  moves: SealedMove[],
  names: PgnNames,
  options: { site?: string; event?: string; today?: string } = {},
): string | null {
  const { text } = pgnMovetext(moves);
  if (text === null) return null;

  const result = pgnResult(session);
  const today = options.today ?? new Date().toISOString().slice(0, 10);

  const header = [
    `[Event "${clean(options.event ?? 'PenPal correspondence')}"]`,
    `[Site "${clean(options.site ?? 'PenPal')}"]`,
    `[Date "${pgnDate(session.createdAt, today)}"]`,
    '[Round "-"]',
    `[White "${clean(names.white)}"]`,
    `[Black "${clean(names.black)}"]`,
    `[Result "${result}"]`,
  ].join('\n');

  // The result is the last token on the last line, and nothing may follow it.
  return `${header}\n\n${wrapMovetext(`${text} ${result}`.trim())}\n`;
}

/**
 * Hand the file to the browser.
 *
 * The object URL is revoked on the next tick rather than left alive: every export
 * would otherwise leak a blob for the lifetime of the tab, and someone exporting
 * a hundred games to try something out would be holding a hundred of them.
 */
export function downloadPgn(filename: string, pgn: string): void {
  const blob = new Blob([pgn], { type: 'application/x-chess-pgn' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.pgn') ? filename : `${filename}.pgn`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** The viewer is white only if they are. Everything else swaps them. */
export function namesFor(
  session: Pick<GameSession, 'youAre'>,
  viewer: string,
  partner: string,
): PgnNames {
  return session.youAre === 'w'
    ? { white: viewer, black: partner }
    : { white: partner, black: viewer };
}

/** `penpal-2026-10-15-margot.pgn`: sortable, and it says whose game it is. */
export function pgnFilename(createdAt: string | null | undefined, whiteName: string): string {
  const day = (createdAt ?? new Date().toISOString()).slice(0, 10);
  const who = whiteName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `penpal-${day}${who ? `-${who}` : ''}`;
}

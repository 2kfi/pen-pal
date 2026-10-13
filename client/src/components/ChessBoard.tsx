import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  GLYPH,
  cloneState,
  file,
  gameResult,
  inCheck,
  initialState,
  legalMoves,
  makeMove,
  rank,
  squareName,
  toSAN,
  type Color,
  type GameResult,
  type GameState,
  type Move,
  type PieceType,
} from '../lib/chessEngine';

/**
 * Chessboard.
 *
 * Backed by lib/chessEngine, whose move generation is verified by perft against
 * published constants. It handles castling, en passant, under-promotion, the
 * fifty-move rule and insufficient material.
 *
 * Search is not yet implemented (plan step 25: a Web Worker with iterative
 * deepening and a transposition table). Until then this is a two-player board;
 * claiming "play the computer" without a search would be a lie in the UI.
 *
 * Interaction, in priority order:
 *
 * 1. PROMOTION IS A CHOICE, NOT A DEFAULT. The engine generates all four
 *    promotions and makeMove applies whichever one you hand it, so the board
 *    collects all four legal moves for the square, opens a picker, and plays
 *    nothing until a piece is chosen. v0.0.2 auto-queened every pawn, which
 *    quietly threw away the whole point of the rule.
 * 2. LAST MOVE, BOTH SIDES. The most recent white move and the most recent
 *    black move are both marked, each in its own tint, so "what just happened"
 *    is answerable on a board where the opponent answered three moves ago.
 * 3. CHECK AND MATE ARE SHAPED, NOT JUST COLOURED. Every state change is
 *    announced in the live region and, on the board itself, carried by a mark
 *    as well as a colour — WCAG 1.4.1.
 * 4. DRAG IS AN ADDITION, NEVER A REQUIREMENT. WCAG 2.2 SC 2.5.7 (Dragging
 *    Movements) is satisfied by keeping click-to-select / click-to-move, and
 *    then a full keyboard path on top of that: arrows move a cursor between
 *    squares, Enter or Space moves the piece. A pointer gesture that cannot be
 *    undone by a pointer gesture is a keyboard user's dead end.
 * 5. CAPTURES AND A MOVE LIST in SAN, with + and # appended from the position
 *    after each move.
 * 6. COORDINATES on the edges, in the corner of the square, small enough to
 *    stay out of the piece's way.
 *
 * Sound is off by default and never autoplays; it is a short synthesised tick,
 * so there is no asset to load and nothing to surprise anyone at 1am.
 */

// The engine's undo stack type is not exported; alias it so this file does not
// have to restate the shape.
type Stack = Parameters<typeof makeMove>[2];

type Promo = Exclude<PieceType, 'k'>;

const PIECE_WORDS: Record<PieceType, string> = {
  k: 'king',
  q: 'queen',
  r: 'rook',
  b: 'bishop',
  n: 'knight',
  p: 'pawn',
};

/** Queen first: it is what people reach for, so it must not be a guess. */
const PROMO_ORDER: Promo[] = ['q', 'r', 'b', 'n'];

const side = (c: Color): string => (c === 'w' ? 'White' : 'Black');

/**
 * U+FE0E (variation selector-15) pins the glyph to text presentation. Without
 * it some platforms promote the chess block to colour emoji and the board turns
 * into a bag of stickers that no longer matches the palette.
 */
const textGlyph = (c: Color, t: PieceType): string => `${GLYPH[c][t]}\uFE0E`;

interface Verdict {
  mark: string;
  tone: 'live' | 'mate' | 'draw';
  text: string;
}

function verdictOf(result: GameResult, loser: Color): Verdict {
  switch (result) {
    case 'checkmate': {
      const winner: Color = loser === 'w' ? 'b' : 'w';
      return { mark: '✖', tone: 'mate', text: `Checkmate — ${side(winner)} wins.` };
    }
    case 'stalemate':
      return { mark: '＝', tone: 'draw', text: 'Stalemate — draw.' };
    case 'fifty-move':
      return { mark: '＝', tone: 'draw', text: 'Draw by the fifty-move rule.' };
    case 'insufficient-material':
      return { mark: '＝', tone: 'draw', text: 'Draw — neither side has enough material to mate.' };
    default:
      return { mark: '', tone: 'live', text: '' };
  }
}

/** Replays a game and returns everything the UI cannot get from the final board. */
interface Timeline {
  pairs: { n: number; w: string | null; b: string | null }[];
  taken: Record<Color, PieceType[]>;
  lastByColor: { w: Move | null; b: Move | null };
}

function buildTimeline(played: Move[]): Timeline {
  const replay = initialState();
  const stack: Stack = [];
  const pairs: Timeline['pairs'] = [];
  const taken: Record<Color, PieceType[]> = { w: [], b: [] };
  const lastByColor: Timeline['lastByColor'] = { w: null, b: null };

  for (const move of played) {
    const mover = replay.turn;
    const n = replay.fullmove;
    let san = toSAN(replay, move);

    makeMove(replay, move, stack);

    // SAN from the engine carries no check marker; the position after the move
    // does, so read it there rather than inventing a second rule for it.
    const after = gameResult(replay);
    if (after === 'checkmate') san += '#';
    else if (after === 'playing' && inCheck(replay, replay.turn)) san += '+';

    if (mover === 'w') {
      const pair = pairs.find((p) => p.n === n);
      if (pair) pair.w = san;
      else pairs.push({ n, w: san, b: null });
    } else {
      const pair = pairs.find((p) => p.n === n);
      if (pair) pair.b = san;
      else pairs.push({ n, w: null, b: san });
    }

    if (move.enPassant) taken[mover].push('p');
    else if (move.captured) taken[mover].push(move.captured);

    lastByColor[mover] = move;
  }

  return { pairs, taken, lastByColor };
}

type Tone = 'move' | 'capture' | 'check';

/**
 * A two-oscillator tick built at play time. Off by default: the app is for
 * writing letters at night, and a board that makes noise before you ask it to
 * is a board people mute in the OS instead.
 */
function useTicker(enabled: boolean) {
  const ctxRef = useRef<AudioContext | null>(null);

  return (tone: Tone) => {
    if (!enabled) return;
    try {
      const Ctor = window.AudioContext;
      const ctx = ctxRef.current ?? new Ctor();
      ctxRef.current = ctx;
      if (ctx.state === 'suspended') void ctx.resume();

      const now = ctx.currentTime;
      const freqs = tone === 'capture' ? [196, 147] : tone === 'check' ? [660, 880] : [330];
      const dur = tone === 'capture' ? 0.18 : 0.13;

      freqs.forEach((f, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const at = now + i * 0.06;
        osc.type = tone === 'capture' ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(f, at);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.05, at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(at);
        osc.stop(at + dur + 0.02);
      });
    } catch {
      // No audio device, no AudioContext, autoplay policy — silence is fine.
    }
  };
}

interface DragState {
  from: number;
  x: number;
  y: number;
  over: number | null;
}

export function ChessBoard() {
  const [game, setGame] = useState<GameState>(initialState);
  const [played, setPlayed] = useState<Move[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  /** Roving-tabindex cursor: the one square in the tab order. */
  const [cursor, setCursor] = useState(52); // e2
  const [status, setStatus] = useState('White to move. Two players, one board.');
  const [promo, setPromo] = useState<Move[] | null>(null);
  const [sound, setSound] = useState(false);
  const [ghost, setGhost] = useState<DragState | null>(null);

  const frameRef = useRef<HTMLDivElement>(null);
  const promoRef = useRef<HTMLDivElement>(null);
  const clickSuppressedUntil = useRef(0);
  const tick = useTicker(sound);

  // The engine mutates while generating, so it works on throwaway copies.
  const legal = useMemo(() => legalMoves(cloneState(game)), [game]);
  const result = useMemo(() => gameResult(cloneState(game)), [game]);
  const checkNow = useMemo(
    () => result === 'playing' && inCheck(cloneState(game), game.turn),
    [game, result],
  );
  /**
   * The square that gets the danger ring: the king that is in check, and after
   * mate the king that was mated. The ring is a colour, so it is paired with a
   * "!" in the corner of the same square — never colour alone (WCAG 1.4.1).
   */
  const dangerSquare = useMemo(() => {
    if (!checkNow && result !== 'checkmate') return -1;
    return game.board.findIndex((p) => p?.c === game.turn && p.t === 'k');
  }, [game, result, checkNow]);

  const timeline = useMemo(() => buildTimeline(played), [played]);

  const targets = useMemo(
    () => new Set(legal.filter((m) => m.from === selected).map((m) => m.to)),
    [legal, selected],
  );

  const highlight = useMemo(() => {
    const from = new Set<number>();
    const to = new Set<number>();
    for (const move of [timeline.lastByColor.w, timeline.lastByColor.b]) {
      if (!move) continue;
      from.add(move.from);
      to.add(move.to);
    }
    return { from, to };
  }, [timeline]);

  const verdict = verdictOf(result, game.turn);
  const live = result === 'playing' && promo === null;

  const focusSquare = (sq: number) => {
    frameRef.current?.querySelector<HTMLElement>(`[data-sq="${sq}"]`)?.focus();
  };

  const commit = (move: Move) => {
    const san = toSAN(game, move);
    const next = cloneState(game);
    const stack: Stack = [];
    makeMove(next, move, stack);

    const res = gameResult(next);
    const checking = res === 'playing' && inCheck(next, next.turn);

    setGame(next);
    setPlayed((history) => [...history, move]);
    setSelected(null);
    setPromo(null);
    setCursor(move.to);

    if (res !== 'playing') {
      // The verdict line above already states the result. Repeating it here
      // would print it twice on the page and read it twice in a live region.
      setStatus(`${san}.`);
      tick(res === 'checkmate' ? 'check' : 'move');
      return;
    }

    setStatus(
      `${san}. ${checking ? `Check — ${side(next.turn)} must answer.` : `${side(next.turn)} to move.`}`,
    );
    tick(checking ? 'check' : move.captured || move.enPassant ? 'capture' : 'move');
  };

  /**
   * Resolves a from/to pair into a move, or opens the promotion picker.
   * Returns false when the pair is not a move at all, so the caller can decide
   * whether to reselect a piece or simply clear.
   */
  const attempt = (from: number, to: number): boolean => {
    const options = legal.filter((m) => m.from === from && m.to === to);
    if (options.length === 0) return false;

    const promotions = options.filter((m) => m.promotion);
    if (promotions.length > 0) {
      // Do not move. Do not default. Ask.
      setSelected(from);
      setPromo(promotions);
      setCursor(to);
      setStatus(
        `Promotion. Choose a piece for the ${side(game.turn)} pawn: queen, rook, bishop or knight. Escape cancels.`,
      );
      return true;
    }

    commit(options[0]);
    return true;
  };

  const cancelPromotion = () => {
    const from = promo?.[0].from ?? null;
    setPromo(null);
    setSelected(null);
    if (from !== null) {
      setCursor(from);
      // Focus goes back to the square the picker was opened from, so a keyboard
      // user is returned to where they were rather than dropped at the top.
      requestAnimationFrame(() => focusSquare(from));
    }
    setStatus(`${side(game.turn)} to move.`);
  };

  const choosePromotion = (piece: Promo) => {
    const move = promo?.find((m) => m.promotion === piece);
    if (move) commit(move);
  };

  const activate = (index: number) => {
    if (clickSuppressedUntil.current > Date.now()) return;
    setCursor(index);

    if (promo) return; // a choice is pending; the board is not listening
    if (!live) return;

    const piece = game.board[index];

    if (selected === null) {
      if (piece && piece.c === game.turn) setSelected(index);
      return;
    }

    if (attempt(selected, index)) return;

    // Not a legal destination: treat a click on your own piece as a new
    // selection, and anything else as a deselect.
    if (piece && piece.c === game.turn) setSelected(index);
    else setSelected(null);
  };

  /* ---------------------------------------------------------------- *
   * pointer drag — an addition to click-to-move, never a replacement  *
   * ---------------------------------------------------------------- */

  const beginDrag = (index: number, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (promo || !live) return;
    const piece = game.board[index];
    if (!piece || piece.c !== game.turn) return;

    const origin = { index, x: event.clientX, y: event.clientY, id: event.pointerId, moved: false };
    let over: number | null = null;

    const squareUnder = (x: number, y: number): number | null => {
      const el = document.elementFromPoint(x, y);
      const cell = el?.closest<HTMLElement>('[data-sq]');
      return cell ? Number(cell.dataset.sq) : null;
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== origin.id) return;
      if (!origin.moved && Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < 6) return;
      origin.moved = true;
      setCursor(origin.index);
      over = squareUnder(ev.clientX, ev.clientY);
      setGhost({ from: origin.index, x: ev.clientX, y: ev.clientY, over });
    };

    const finish = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      setGhost(null);
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== origin.id) return;
      const dragged = origin.moved;
      const landed = over;
      finish();
      if (!dragged) return; // a tap: let the click handler deal with it

      // The browser still synthesises a click after a drag; drop it, or the
      // piece lands twice.
      clickSuppressedUntil.current = Date.now() + 400;

      const to = landed ?? squareUnder(ev.clientX, ev.clientY);
      if (to === null) {
        setSelected(null);
        return;
      }
      setCursor(to);
      if (!attempt(origin.index, to)) {
        const piece = game.board[to];
        setSelected(piece && piece.c === game.turn ? to : null);
      }
    };

    const onCancel = () => finish();

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };

  /* ---------------------------------------------------------------- *
   * keyboard                                                          *
   * ---------------------------------------------------------------- */

  const onSquareKeyDown = (index: number, event: KeyboardEvent<HTMLButtonElement>) => {
    const f = file(index);
    const r = rank(index);
    let next: number | null = null;

    if (event.key === 'ArrowLeft') next = f > 0 ? index - 1 : null;
    else if (event.key === 'ArrowRight') next = f < 7 ? index + 1 : null;
    else if (event.key === 'ArrowUp') next = r > 0 ? index - 8 : null;
    else if (event.key === 'ArrowDown') next = r < 7 ? index + 8 : null;
    else if (event.key === 'Home') next = r * 8;
    else if (event.key === 'End') next = r * 8 + 7;
    else if (event.key === 'Escape' && selected !== null) {
      event.preventDefault();
      setSelected(null);
      setStatus(`${side(game.turn)} to move.`);
      return;
    } else return;

    if (next === null) return;
    event.preventDefault();
    setCursor(next);
    focusSquare(next);
  };

  const onPromoKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const options = Array.from(event.currentTarget.querySelectorAll('button'));
    const at = options.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelPromotion();
      return;
    }

    let step = 0;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') step = 1;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') step = -1;
    else if (event.key === 'Home') step = -at;
    else if (event.key === 'End') step = options.length - 1 - at;
    else return;

    event.preventDefault();
    event.stopPropagation();
    options[(at + step + options.length) % options.length]?.focus();
  };

  // Focus enters the picker when it opens; it traps nothing, so Escape is
  // always available and Tab still leaves it.
  useEffect(() => {
    if (!promo) return;
    promoRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [promo]);

  /* ---------------------------------------------------------------- *
   * game control                                                      *
   * ---------------------------------------------------------------- */

  const reset = () => {
    setGame(initialState());
    setPlayed([]);
    setSelected(null);
    setPromo(null);
    setCursor(52);
    setStatus('White to move. New game.');
  };

  /**
   * Take back the last move. The engine's state is rebuilt by replaying the
   * remaining moves from the start position rather than by hand-editing the
   * board, because castling rights, the en-passant square and the halfmove clock
   * all have to unwind together and it is easy to get subtly wrong.
   */
  const undo = () => {
    if (played.length === 0) return;
    const remaining = played.slice(0, -1);
    const replay = initialState();
    const stack: Stack = [];
    for (const m of remaining) makeMove(replay, m, stack);

    setGame(replay);
    setPlayed(remaining);
    setSelected(null);
    setPromo(null);
    setCursor(52);
    setStatus(`${side(replay.turn)} to move. Last move taken back.`);
  };

  const draggedPiece = ghost ? game.board[ghost.from] : null;

  return (
    <div className="cb">
      <div className="cb-frame" ref={frameRef}>
        <div className="cb-board" role="grid" aria-label="Chess board">
          {game.board.map((piece, index) => {
            const light = (rank(index) + file(index)) % 2 === 1;
            const classes = ['cb-sq'];
            if (light) classes.push('cb-sq--light');
            if (selected === index) classes.push('cb-sq--selected');
            if (targets.has(index)) classes.push('cb-sq--target');
            if (highlight.from.has(index)) classes.push('cb-sq--from');
            if (highlight.to.has(index)) classes.push('cb-sq--to');
            if (index === dangerSquare) classes.push('cb-sq--check');
            if (ghost && ghost.from === index) classes.push('cb-sq--lifted');

            const hints: string[] = [];
            if (piece) hints.push(`${piece.c === 'w' ? 'white' : 'black'} ${PIECE_WORDS[piece.t]}`);
            else hints.push('empty');
            if (selected === index) hints.push('selected');
            if (targets.has(index)) hints.push('legal destination');
            if (highlight.from.has(index)) hints.push('last move from');
            if (highlight.to.has(index)) hints.push('last move to');
            if (index === dangerSquare) hints.push(result === 'checkmate' ? 'checkmated' : 'in check');

            return (
              <button
                key={index}
                type="button"
                role="gridcell"
                data-sq={index}
                data-light={light ? 'true' : 'false'}
                className={classes.join(' ')}
                tabIndex={cursor === index ? 0 : -1}
                aria-label={`${squareName(index)}, ${hints.join(', ')}`}
                aria-pressed={selected === index}
                onClick={() => activate(index)}
                onPointerDown={(event) => beginDrag(index, event)}
                onKeyDown={(event) => onSquareKeyDown(index, event)}
                onFocus={() => setCursor(index)}
              >
                {/* Coordinates live in the corner of the edge squares so they
                    read without ever sitting under a piece. */}
                {file(index) === 0 && <span className="cb-coord cb-coord--rank" aria-hidden>{8 - rank(index)}</span>}
                {rank(index) === 7 && <span className="cb-coord cb-coord--file" aria-hidden>{squareName(index).slice(0, 1)}</span>}
                {piece && <span className={`cb-piece cb-piece--${piece.c}`} aria-hidden>{textGlyph(piece.c, piece.t)}</span>}
                {index === dangerSquare && <span className="cb-check-mark" aria-hidden>!</span>}
              </button>
            );
          })}
        </div>

        {promo && (
          <div
            className="cb-promo"
            role="dialog"
            aria-label={`Promotion. Choose a piece for the ${side(game.turn)} pawn.`}
            data-side={game.turn}
            style={{ '--cb-file': file(promo[0].to), '--cb-rank': rank(promo[0].to) } as CSSProperties}
            ref={promoRef}
            onKeyDown={onPromoKeyDown}
          >
            {PROMO_ORDER.map((piece) => (
              <button
                key={piece}
                type="button"
                className="cb-promo-btn"
                onClick={() => choosePromotion(piece)}
                aria-label={`Promote to ${PIECE_WORDS[piece]}`}
              >
                <span aria-hidden>{textGlyph(game.turn, piece)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* One live region for the whole board: turn, check, mate, promotion. */}
      <div className="cb-statusbar" role="status" aria-live="polite" aria-atomic="true">
        {verdict.text && (
          <p className={`cb-verdict cb-verdict--${verdict.tone}`}>
            <span className="cb-verdict-mark" aria-hidden>{verdict.mark}</span>
            {verdict.text}
          </p>
        )}
        <p className="cb-status">
          {checkNow && verdict.tone === 'live' && (
            <span className="cb-flag cb-flag--check" aria-hidden>!</span>
          )}
          {status}
        </p>
      </div>

      <div className="cb-panel">
        <div className="cb-trays">
          {(['w', 'b'] as Color[]).map((c) => {
            // A captured piece always belonged to the other side, and it keeps
            // its own colour in the tray: "White took ♞♟" should show black
            // pieces, not white ones drawn in white's ink.
            const victim: Color = c === 'w' ? 'b' : 'w';
            return (
              <div className="cb-tray" key={c}>
                <span className="cb-label">{`${side(c)} took`}</span>
                <span className="cb-tray-pieces" aria-label={`${side(c)} captured ${timeline.taken[c].length} pieces`}>
                  {timeline.taken[c].length === 0 ? (
                    <span className="cb-tray-empty">—</span>
                  ) : (
                    timeline.taken[c].map((piece, i) => (
                      <span key={`${piece}-${i}`} className={`cb-loose cb-piece--${victim}`} aria-hidden>
                        {textGlyph(victim, piece)}
                      </span>
                    ))
                  )}
                </span>
              </div>
            );
          })}
        </div>

        <div className="cb-controls">
          <button type="button" className="cb-btn" onClick={reset}>New game</button>
          <button type="button" className="cb-btn" onClick={undo} disabled={played.length === 0}>
            Take back
          </button>
          <button
            type="button"
            className="cb-btn"
            aria-pressed={sound}
            onClick={() => {
              setSound((s) => !s);
              if (!sound) tick('move');
            }}
          >
            Sound: {sound ? 'on' : 'off'}
          </button>
          {promo && (
            <button type="button" className="cb-btn" onClick={cancelPromotion}>
              Cancel promotion
            </button>
          )}
        </div>

        <div className="cb-notelist">
          <span className="cb-label" id="cb-moves-label">Moves</span>
          {timeline.pairs.length === 0 ? (
            <p className="cb-empty">No moves yet.</p>
          ) : (
            <ol className="cb-moves" aria-labelledby="cb-moves-label">
              {timeline.pairs.map((pair) => (
                <li key={pair.n} className="cb-move-pair">
                  <span className="cb-move-n">{pair.n}.</span>
                  <span className="cb-move">{pair.w ?? ''}</span>
                  <span className="cb-move">{pair.b ?? ''}</span>
                </li>
              ))}
            </ol>
          )}
        </div>

        <p className="cb-help">
          Click a piece, then click a square — or drag it. With a keyboard: arrow keys move between squares,
          Enter or Space moves the piece, Escape puts it back down.
        </p>
      </div>

      {ghost &&
        draggedPiece &&
        createPortal(
          <span
            className={`cb-ghost cb-piece--${draggedPiece.c}`}
            style={{ transform: `translate3d(${ghost.x}px, ${ghost.y}px, 0) translate(-50%, -58%)` }}
            aria-hidden
          >
            {textGlyph(draggedPiece.c, draggedPiece.t)}
          </span>,
          document.body,
        )}
    </div>
  );
}

export default ChessBoard;
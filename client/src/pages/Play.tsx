import { useCallback, useEffect, useRef, useState } from 'react';
import { ChessBoard } from '../components/ChessBoard';
import {
  LEVEL_LABELS,
  createChessEngine,
  type ChessEngine,
  type EngineLevel,
} from '../lib/chessSearch';
import type { Color, GameState, Move } from '../lib/chessEngine';

/**
 * Play.
 *
 * Three ways to play, chosen explicitly rather than guessed:
 *
 *   two players   both sides on this device
 *   computer      iterative-deepening search in a Web Worker (plan step 25).
 *                 v0.0.2 ran a depth-2 material-only search synchronously on the
 *                 main thread and froze the page for its duration. This one
 *                 yields every 10ms, so the board stays at ~60fps for the whole
 *                 search and the reader can cancel mid-thought.
 *   pen pal       moves sealed in the browser and relayed by the server, so
 *                 neither player sees a move the other has not sent (step 26).
 *
 * ChessBoard is imported here, and its engine module through it, on purpose: an
 * asset nothing imports is an asset that never reaches the production bundle,
 * so the Worker would be discoverable in dev and absent from a build.
 */

type Mode = 'two-player' | 'computer' | 'pen-pal';

const LEVELS: EngineLevel[] = ['beginner', 'casual', 'club', 'tough', 'strong'];

export default function Play() {
  const [mode, setMode] = useState<Mode>('two-player');
  // Remounting the board is the reset: the engine, the search budget and the
  // move list all have to unwind together, and three separate reset paths
  // would eventually disagree with each other.
  const [gameId, setGameId] = useState(0);

  return (
    <div className="play">
      <h1>Play</h1>

      <div className="row" role="radiogroup" aria-label="Game mode">
        {(
          [
            ['two-player', 'Two players'],
            ['computer', 'Against the computer'],
            ['pen-pal', 'With your pen pal'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            className={mode === value ? 'primary' : undefined}
            onClick={() => setMode(value)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="row" style={{ marginTop: 'var(--space-3)' }}>
        <button type="button" onClick={() => setGameId((n) => n + 1)}>
          New game
        </button>
      </div>

      {mode === 'two-player' ? (
        <ChessBoard key={gameId} />
      ) : mode === 'computer' ? (
        <EngineGame key={gameId} />
      ) : (
        <PenPalGame />
      )}
    </div>
  );
}

/** Human against the search. */
function EngineGame() {
  const [level, setLevel] = useState<EngineLevel>('casual');
  const [humanColor, setHumanColor] = useState<Color>('w');

  const [thinking, setThinking] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  /** Bumped per engine reply so ChessBoard replays an identical move twice. */
  const [engineMove, setEngineMove] = useState<{ move: Move; seq: number } | null>(null);
  const seq = useRef(0);

  const engineRef = useRef<ChessEngine | null>(null);
  const [degraded, setDegraded] = useState<string | null>(null);
  const [transport, setTransport] = useState<'worker' | 'main-thread' | null>(null);

  useEffect(() => {
    const engine = createChessEngine({ level });
    engineRef.current = engine;
    setTransport(engine.transport);
    setDegraded(engine.degradation);
    return () => {
      // dispose() kills the Worker outright. Without it the worker outlives the
      // page and keeps burning CPU after you have navigated away.
      engine.dispose();
      engineRef.current = null;
    };
  }, [level]);

  /**
   * Run the search and hand the reply back to the board.
   *
   * The search runs off the main thread, so this yields immediately and the
   * board stays interactive — including the Stop button that aborts it.
   */
  const reply = useCallback(
    async (after: GameState) => {
      const engine = engineRef.current;
      if (!engine) return;

      setThinking(true);
      setLine(null);
      try {
        const result = await engine.bestMove(after, level);
        setTransport(engine.transport);
        setDegraded(engine.degradation);

        if (!result.move) {
          setLine('No legal move.');
          return;
        }

        setLine(
          `${LEVEL_LABELS[level]} played ${result.san ?? 'a move'} — ` +
            `depth ${result.depth}, ${(result.nodes / 1000).toFixed(0)}k nodes in ${result.ms} ms` +
            (result.truncated ? ', cut short' : '') +
            '.',
        );
        seq.current += 1;
        setEngineMove({ move: result.move, seq: seq.current });
      } catch (err) {
        setLine(err instanceof Error ? `The search failed: ${err.message}` : 'The search failed.');
      } finally {
        setThinking(false);
      }
    },
    [level],
  );

  const stop = () => {
    engineRef.current?.stop();
    setLine('Stopped. It played what it had.');
  };

  return (
    <div>
      <div className="row" role="radiogroup" aria-label="Difficulty">
        {LEVELS.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={level === option}
            className={level === option ? 'primary' : undefined}
            onClick={() => setLevel(option)}
          >
            {LEVEL_LABELS[option]}
          </button>
        ))}
      </div>

      <div className="row" style={{ marginTop: 'var(--space-2)' }}>
        <span className="muted">You play</span>
        {(['w', 'b'] as Color[]).map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={humanColor === c}
            className={humanColor === c ? 'primary' : undefined}
            onClick={() => setHumanColor(c)}
          >
            {c === 'w' ? 'White' : 'Black'}
          </button>
        ))}
        <button type="button" onClick={stop} disabled={!thinking}>
          Stop thinking
        </button>
      </div>

      {/*
        transport is null until the engine exists, because the Worker is created
        lazily. Reporting "main-thread" during that window would accuse a healthy
        browser of being degraded.
      */}
      {transport && !degraded && (
        <p className="muted">Searching in a Web Worker, so this page stays responsive.</p>
      )}
      {degraded && <p className="muted">{degraded}</p>}

      <ChessBoard
        humanColor={humanColor}
        onMove={(_move, after) => void reply(after)}
        engineMove={engineMove}
        status={
          thinking
            ? `${LEVEL_LABELS[level]} is thinking. The board stays live.`
            : undefined
        }
      />

      {line && (
        <p className="muted" role="status" aria-live="polite">
          {line}
        </p>
      )}
    </div>
  );
}

/**
 * Two people, one board.
 *
 * Deliberately not faked. The server half of step 26 exists and its tests play a
 * real game with the position sealed in the browser, but this page is not wired
 * to it yet, and a button that says "start a game" and does nothing is worse
 * than saying so.
 */
function PenPalGame() {
  return (
    <div className="card">
      <h2>Play your pen pal</h2>
      <p className="muted">
        A game between you two: every move is sealed in your browser before it is sent, so neither of
        you can see a position the other has not sent, and the server stores only ciphertext.
      </p>
      <p className="muted">
        This screen is not connected yet. The rules, the encryption and the server routes are built
        and tested — what is missing is the page that drives them.
      </p>
    </div>
  );
}
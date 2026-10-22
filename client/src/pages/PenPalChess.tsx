import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChessBoard } from '../components/ChessBoard';
import { activeKey, useVault } from '../lib/vault';
import { useAuth } from '../stores/auth';
import { usePairing } from '../stores/pairing';
import { useGames, type GamesState } from '../stores/games';
import {
  describeOutcome,
  isOver,
  type GameSession,
  type GameSummary,
  type SealedMove,
} from '../lib/chessGames';
import { formatDay } from '../lib/dailyPuzzle';
import { downloadPgn, namesFor, pgnFilename, toPgn } from '../lib/pgn';
import type { Color, Move } from '../lib/chessEngine';
import '../penschess.css';

/**
 * Chess between two people who write to each other (plan step 26).
 *
 * The server holds a sealed position, a clock and a pair of user ids. This page
 * holds nothing it was not given: it asks for the live game, opens the position
 * with the reader's own key, and puts a board on the screen.
 *
 * Five decisions this page is built around, each of which is a decision rather
 * than an implementation detail.
 *
 * **1. The board is drawn from the record, not from what this tab saw.**
 * The `record` prop makes ChessBoard replay the sealed move list, so the squares
 * on screen are the squares the server is holding. A rejected move is therefore
 * not something the page has to undo: the record has not changed, so the board
 * is put back where the record says it is.
 *
 * **2. The wait state is a sentence, and it is true.**
 * "Sam is to move. Nothing has arrived for two days." It does not say Sam is
 * thinking, or that Sam has read it, or that a move is in flight. There is no
 * delivery animation here, because the server has nothing to animate: a move
 * exists or it does not, and until it exists the honest sentence is the second
 * one.
 *
 * **3. Every ending is spelled out from one place.**
 * `describeOutcome` owns the wording for checkmate, stalemate, resignation, an
 * agreed draw and a clock that ran out. This page adds no vocabulary of its own,
 * because "you win" and "you win by resignation" are different messages and a
 * page that cannot tell them apart gets argued with.
 *
 * **4. Offers are not actions.**
 * A take-back the partner has not accepted leaves the board exactly where it
 * was. Offering one is a request with a button next to it that only the other
 * player can press, and until they press it the position is unchanged.
 *
 * **5. An unopenable position is an error, never an empty board.**
 * A locked vault, a missing key or a position that will not decrypt stops this
 * page before it draws anything, because an empty board looks exactly like "your
 * partner has not moved yet" and a page that cannot tell those apart will
 * eventually tell somebody the wrong one.
 */

interface PenPalChessProps {
  /**
   * Render the heading at level 2. Set when the page is embedded in another
   * view, so the host keeps the single `h1` that view already has.
   */
  embedded?: boolean;
}

/** "Sam" rather than "sam908460638": a username is a login, not a person. */
/**
 * A person's name, cleaned of the machine suffix an account id leaves behind.
 *
 * The fallback is a parameter because "your partner" is right on the board and
 * wrong in a PGN header, which has to name two people for a reader who was
 * never in this app.
 */
function nameOf(
  who: { friendly_name?: string | null; username?: string | null } | null | undefined,
  fallback = 'your partner',
): string {
  const friendly = who?.friendly_name?.trim();
  const username = who?.username?.trim() ?? '';
  const looksLikeMachine = (s: string) => /\d{3,}$/.test(s);
  if (friendly && !looksLikeMachine(friendly)) return friendly;
  const word = (username || friendly || '').split(/[_\-.]+/)[0] ?? '';
  const cleaned = word.replace(/\d+$/, '');
  if (!cleaned) return fallback;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** Whole units only. "three minutes" is the useful half of a countdown. */
function sinceWords(from: string | null | undefined, now = Date.now()): string | null {
  if (!from) return null;
  const t = Date.parse(from);
  if (Number.isNaN(t)) return null;
  const seconds = Math.max(0, Math.round((now - t) / 1000));
  if (seconds < 60) return 'a moment';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

function longDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return formatDay(iso.slice(0, 10));
}

/**
 * Write the game out as PGN.
 *
 * A record that will not replay returns null rather than a broken file: the
 * failure would surface in some chess program, months later, with nobody left
 * who could explain it. So the button says so instead.
 */
function exportPgn(
  session: GameSession,
  moves: SealedMove[],
  viewerName: string,
  partnerName: string,
  setNotice: (text: string) => void,
): void {
  const names = namesFor(session, viewerName, partnerName);
  const pgn = toPgn(session, moves, names, { site: window.location.host });
  if (pgn === null) {
    setNotice('This game could not be written out. Its own move record does not replay.');
    return;
  }
  downloadPgn(pgnFilename(session.createdAt, names.white), pgn);
  setNotice('Saved as a PGN file. Chess programs can read it.');
}

/**
 * Join postmark facts with the separator, dropping the absent ones.
 *
 * The point is not tidiness. A separator with nothing beside it is a bullet
 * point in disguise, and the design direction says dots separate real facts, so
 * a missing date has to remove its own dot rather than render a dash in its
 * place.
 */
function facts(...parts: (string | number | false | null | undefined)[]): string {
  return parts.filter((part): part is string | number => part !== '' && part != null && part !== false).join(' · ');
}

/** A deadline needs the hour, not just the day. */
function stamp(iso: string | null | undefined): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  return `${formatDay(iso.slice(0, 10))}, ${new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

/**
 * What is true right now, in one line, for the live region.
 *
 * Derived from the session rather than accumulated as messages, so it cannot
 * drift out of step with the board: there is exactly one sentence per state and
 * it is recomputed from the record every render.
 */
export function stateLine(
  session: GameSession,
  viewerId: number,
  partnerName: string,
  notice: string,
  now = Date.now(),
): string {
  const outcome = describeOutcome(session, viewerId, partnerName);
  if (isOver(session.status)) return outcome;

  // `notice` is the store's own report of an exchange ("Take-back declined. The
  // move stands."). It is dropped when it is only the outcome again, which is
  // what it becomes on every adopt.
  const head = notice && notice !== outcome ? `${notice} ` : '';

  if (session.turn !== session.youAre) {
    const quiet = sinceWords(session.lastMoveAt ?? session.createdAt, now);
    return `${head}${partnerName} is to move. ${quiet ? `Nothing has arrived for ${quiet}.` : 'Nothing has arrived yet.'}`;
  }
  return `${head}${outcome}`;
}

export default function PenPalChess({ embedded = false }: PenPalChessProps = {}) {
  const games = useGames();
  const vaultStatus = useVault((s) => s.status);
  const me = useAuth((s) => s.user);
  const partner = usePairing((s) => s.partner);
  const { load, play, create, resign, offerDraw, acceptDraw, declineDraw, offerUndo, acceptUndo, declineUndo } = games;

  const partnerName = useMemo(() => nameOf(partner), [partner]);
  // The viewer's own name goes in the PGN header. A PGN that says "White" and
  // "Black" instead of the two people is technically valid and useless to
  // anybody who wants to remember who they were playing.
  const viewerName = useMemo(() => nameOf(me, 'Unknown'), [me]);
  const viewerId = me?.id ?? 0;
  const session = games.session;

  /**
   * What tells ChessBoard to redraw from the record.
   *
   * The envelope is the identity of a position: every move reseals it with a
   * fresh IV, so the string changes exactly when the position does. The counter
   * covers the two cases a string cannot: arriving for the first time, and being
   * put back after a move the server refused.
   */
  const [nonce, setNonce] = useState(0);
  /**
   * What the export button last did, kept here rather than in the store.
   *
   * The store's `notice` belongs to the actions that set it, and an export
   * writing over it would make the store disagree with the sentence it just
   * announced about whose turn it is.
   */
  const [exportNote, setExportNote] = useState('');
  useEffect(() => {
    setNonce((n) => n + 1);
  }, [session?.encryptedState]);

  /**
   * A refused move must not stay on the board.
   *
   * ChessBoard applies a move the moment it is made, so it needs telling when
   * the server said no. Bumping the nonce replays the record over the optimistic
   * move, which is the same thing as taking it back.
   */
  const refusal = games.error;
  useEffect(() => {
    if (refusal) setNonce((n) => n + 1);
  }, [refusal]);

  /**
   * Only the first read is a loading screen. The store sets `loading` on every
   * refresh too, and a page that says "opening" every time you ask it a question
   * is a page that cannot tell you anything.
   */
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    void load().finally(() => setOpened(true));
  }, [load]);

  /**
   * Coming back to the tab is a user action, so re-reading the record then is
   * fair. There is no poll: this is correspondence, and a page that refreshed
   * itself every ten seconds would be a page that could never be left open on a
   * phone overnight.
   */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const locked = vaultStatus !== 'unlocked' || !activeKey();
  const Heading = embedded ? 'h2' : 'h1';

  return (
    <div className="pp">
      <Heading className="pp-heading">{partner ? `Chess with ${partnerName}` : 'Chess'}</Heading>
      <p className="pp-lede">
        Every move is sealed here, on this device, before it is sent. The server keeps the position
        as ciphertext and has no key to open it with.
      </p>

      {locked ? (
        <LockedArchive />
      ) : !me ? (
        <p className="pp-note">Sign in to play.</p>
      ) : !partner ? (
        <NoPartner />
      ) : (
        <>
          {/*
            Page-level failures (nothing sealed, nothing sent) read at the top;
            anything about a move is reported beside the board instead, so the
            sentence lands next to the thing it is about.
          */}
          {!session && games.error && (
            <p className="alert" role="alert">
              {games.error}
            </p>
          )}

          {session ? (
            <Table
              session={session}
              viewerId={viewerId}
              viewerName={viewerName}
              partnerName={partnerName}
              exportNote={exportNote}
              setExportNote={setExportNote}
              nonce={nonce}
              store={games}
              onPlay={play}
              onResign={resign}
              onOfferDraw={offerDraw}
              onAcceptDraw={acceptDraw}
              onDeclineDraw={declineDraw}
              onOfferUndo={offerUndo}
              onAcceptUndo={acceptUndo}
              onDeclineUndo={declineUndo}
            />
          ) : (
            <StartGame
              busy={games.sending}
              loading={!opened}
              onStart={(color) => void create(color)}
            />
          )}

          <Games history={games.history} viewerId={viewerId} partnerName={partnerName} />
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * states that stop the board being drawn                               *
 * ------------------------------------------------------------------ */

function LockedArchive() {
  return (
    <div className="pp-stop">
      <h3>Your archive is locked</h3>
      <p>
        The position is sealed to your key, so there is nothing to draw until it is unlocked. It
        will not fall back to an empty board: an empty board is what your partner&rsquo;s silence
        looks like.
      </p>
      <Link className="button" to="/letters">
        Unlock your archive
      </Link>
    </div>
  );
}

function NoPartner() {
  return (
    <div className="pp-stop">
      <h3>There is nobody to play</h3>
      <p>Chess here is between the two of you. Invite one person, and this board opens for you both.</p>
      <Link className="button" to="/pairing">
        Send an invite
      </Link>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * starting                                                           *
 * ------------------------------------------------------------------ */

function StartGame({
  busy,
  loading,
  onStart,
}: {
  busy: boolean;
  loading: boolean;
  onStart: (color: Color) => void;
}) {
  if (loading)
    return (
      <p className="pp-note" role="status" aria-busy="true">
        Opening your archive&hellip;
      </p>
    );

  return (
    <div className="pp-stop">
      <h3>No game is in progress</h3>
      <p>
        Start one and it waits for both of you. White moves first; there is no clock ticking while
        you decide, only a deadline, and a game is ended by the server if it is left past that.
      </p>
      <div className="pp-choices">
        <button type="button" className="pp-primary" disabled={busy} onClick={() => onStart('w')}>
          {busy ? 'Sealing the board…' : 'Play white'}
        </button>
        <button type="button" disabled={busy} onClick={() => onStart('b')}>
          Play black
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * the table                                                           *
 * ------------------------------------------------------------------ */

type Store = GamesState;

function Table({
  session,
  viewerId,
  viewerName,
  partnerName,
  exportNote,
  setExportNote,
  nonce,
  store,
  onPlay,
  onResign,
  onOfferDraw,
  onAcceptDraw,
  onDeclineDraw,
  onOfferUndo,
  onAcceptUndo,
  onDeclineUndo,
}: {
  session: GameSession;
  viewerId: number;
  viewerName: string;
  partnerName: string;
  exportNote: string;
  setExportNote: (text: string) => void;
  nonce: number;
  store: Store;
  onPlay: (move: Move) => void;
  onResign: () => void;
  onOfferDraw: () => void;
  onAcceptDraw: () => void;
  onDeclineDraw: () => void;
  onOfferUndo: () => void;
  onAcceptUndo: () => void;
  onDeclineUndo: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const resignYes = useRef<HTMLButtonElement>(null);

  /**
   * Asking to resign moves the question, so focus moves with it. Otherwise the
   * next Tab leaves the answer behind and a keyboard user has to walk the page
   * again to find out what happened.
   */
  useEffect(() => {
    if (confirming) resignYes.current?.focus();
  }, [confirming]);
  const over = isOver(session.status);
  const yours = session.turn === session.youAre;
  const busy = store.sending;

  // An offer of mine that is standing is printed in full further down this
  // column, so the store's notice about the very same offer would say it twice.
  const mineOutstanding = session.undo?.fromYou === true || session.draw?.fromYou === true;
  const line = stateLine(session, viewerId, partnerName, mineOutstanding ? '' : store.notice);

  // The rolled-back position is held in memory by the store, not by the server,
  // so a take-back can only be offered while the move that would be taken back
  // is still in front of you. After a refresh there is nothing to offer and the
  // button is not drawn, rather than drawn and refused.
  const canOfferUndo =
    !over && !session.undo && store.previous !== null && session.lastMoveBy === viewerId;

  const clock = session.turnDeadline ? (
    <p className="pp-clock">
      {yours ? 'You must move by' : `${partnerName} must move by`} {stamp(session.turnDeadline)}
    </p>
  ) : (
    <p className="pp-clock">No clock is running on this game.</p>
  );

  return (
    <section aria-label={`Chess with ${partnerName}`}>
      {/*
          The one live region this page owns, and the first thing on the page.
          ChessBoard announces the move that was just played and the turn; this
          announces what the board cannot know: that nothing has arrived, and how
          the game ended. Above the board rather than in the side column because
          on a phone the side column is below the move list, and a sentence you
          have to scroll to find is not a state you can trust.
        */}
      <p className={`pp-state${over ? ' pp-state--over' : ''}`} role="status" aria-live="polite">
        {busy ? 'Sealing the move…' : line}
      </p>

      {store.error && (
        <p className="pp-error" role="status">
          {store.error}
        </p>
      )}

      <div className="pp-table">
        <div className="pp-board">
          <ChessBoard
            record={{ moves: store.moves, nonce }}
            humanColor={session.youAre ?? undefined}
            onMove={(move) => void onPlay(move)}
          />
        </div>

        <div className="pp-side">
          {!over && clock}

        {session.draw && !session.draw.fromYou && (
          <div className="pp-offer">
            <p className="pp-offer-text">{partnerName} has offered a draw.</p>
            <div className="pp-choices">
              <button type="button" className="pp-primary" disabled={busy} onClick={onAcceptDraw}>
                Agree a draw
              </button>
              <button type="button" disabled={busy} onClick={onDeclineDraw}>
                Keep playing
              </button>
            </div>
          </div>
        )}

        {session.draw?.fromYou && (
          <p className="pp-offer-text">You have offered a draw. It stands until they answer.</p>
        )}

        {session.undo && !session.undo.fromYou && (
          <div className="pp-offer">
            <p className="pp-offer-text">
              {partnerName} would like to take back their last move. The board does not move until
              you agree.
            </p>
            <div className="pp-choices">
              <button type="button" className="pp-primary" disabled={busy} onClick={onAcceptUndo}>
                Allow the take-back
              </button>
              <button type="button" disabled={busy} onClick={onDeclineUndo}>
                The move stands
              </button>
            </div>
          </div>
        )}

        {session.undo?.fromYou && (
          <p className="pp-offer-text">
            You have offered to take back your move. It happens only if {partnerName} accepts.
          </p>
        )}

        {/*
            Offers and resigning are actions, not moves, so they are not hidden
            when it is the other player's turn. That matters most for the
            take-back: the only moment it can be offered is immediately after you
            have moved, which is precisely the moment it is no longer your turn.
            Gating these on `yours` would have made a take-back impossible to
            offer at all.
          */}
        <div className="pp-actions">
          {!over && (
            <>
              {!session.draw && (
                <button type="button" disabled={busy} onClick={onOfferDraw}>
                  Offer a draw
                </button>
              )}
              {canOfferUndo && (
                <button type="button" disabled={busy} onClick={onOfferUndo}>
                  Take back my move
                </button>
              )}
              <button type="button" disabled={busy} onClick={() => setConfirming(true)}>
                Resign
              </button>
            </>
          )}

          {/*
              The one control that is always here. A page that was already open
              when the other player moved, answered an offer, or ended the game is
              showing a position that has moved on, and nothing else on this page
              would notice: there is no poll, so a game that ends while you are
              looking away has to be able to reach you when you come back.
            */}
          <button type="button" disabled={busy} onClick={() => void store.load()}>
            {over ? 'Check again' : yours ? 'Check for their answer' : 'Check for their move'}
          </button>
        </div>

        {confirming && !over && (
          <div className="pp-confirm" role="group" aria-labelledby="pp-resign-heading">
            <p className="pp-offer-text" id="pp-resign-heading">
              Resigning ends the game for good. Nothing can undo it.
            </p>
            <div className="pp-choices">
              <button
                type="button"
                className="pp-primary"
                ref={resignYes}
                onClick={() => {
                  setConfirming(false);
                  onResign();
                }}
              >
                Yes, resign
              </button>
              <button type="button" onClick={() => setConfirming(false)}>
                Keep playing
              </button>
            </div>
          </div>
        )}

        <p className="pp-foot">
          {facts(
            session.youAre === 'w' ? 'played white' : 'played black',
            `${store.moves.length} ${store.moves.length === 1 ? 'move' : 'moves'}`,
            longDate(session.createdAt) && `started ${longDate(session.createdAt)}`,
          )}
        </p>

        {/*
          The export is offered for a game in progress as well as a finished one:
          the result tag becomes "*", which is what tells a reader it stopped
          here rather than ending. Someone mid-game who wants the file should not
          have to finish or resign first.

          Only when there is something to export. A button that always works but
          produces an empty game is worse than no button.
        */}
        {exportNote && (
          <p className="pp-note" role="status">
            {exportNote}
          </p>
        )}

        {store.moves.length > 0 && (
          <p className="pp-foot">
            <button type="button" className="pp-link" onClick={() => exportPgn(session, store.moves, viewerName, partnerName, setExportNote)}>
              Export this game as PGN
            </button>
          </p>
        )}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * the list of games                                                   *
 * ------------------------------------------------------------------ */

function Games({
  history,
  viewerId,
  partnerName,
}: {
  history: GameSummary[];
  viewerId: number;
  partnerName: string;
}) {
  // Only what is over. The game in progress is the board, three lines above, and
  // listing it again here would say "Your move." under a heading that means
  // something else entirely.
  const finished = history.filter((game) => game.status !== 'open');
  if (finished.length === 0) return null;

  return (
    <section className="pp-games" aria-labelledby="pp-games-heading">
      <h3 id="pp-games-heading">Finished games</h3>
      <ul className="pp-list">
        {finished.map((game) => (
          <li className="pp-game" key={game.id}>
            <p className="pp-game-postmark">
              {facts(
                longDate(game.updatedAt),
                `${game.moveCount} ${game.moveCount === 1 ? 'move' : 'moves'}`,
                `played ${game.youAre === 'w' ? 'white' : 'black'}`,
              )}
            </p>
            {/* A GameSummary carries every field describeOutcome reads (status,
                winner, turn and side, so the archive and the board cannot end
                up using two vocabularies for the same result. */}
            <p className="pp-game-outcome">{describeOutcome(game as unknown as GameSession, viewerId, partnerName)}</p>
          </li>
        ))}
      </ul>
      <p className="pp-note">
        The position of a finished game is not on this page. It is sealed, and the only copy is the
        one you keep.
      </p>
    </section>
  );
}